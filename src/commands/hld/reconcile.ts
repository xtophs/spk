import child_process from "child_process";
import commander from "commander";
import { writeFileSync } from "fs";
import yaml from "js-yaml";
import path from "path";
import process from "process";
import shelljs, { TestOptions } from "shelljs";
import { Bedrock } from "../../config";
import { assertIsStringWithContent } from "../../lib/assertions";
import { build as buildCmd, exit as exitCmd } from "../../lib/commandBuilder";
import { TraefikIngressRoute } from "../../lib/traefik/ingress-route";
import {
  ITraefikMiddleware,
  TraefikMiddleware
} from "../../lib/traefik/middleware";
import { logger } from "../../logger";
import { IBedrockFile, IBedrockServiceConfig } from "../../types";
import decorator from "./reconcile.decorator.json";

/**
 * IExecResult represents the possible return value of a Promise based wrapper
 * for child_process.exec(). `error` would specify an optional ExecException
 * which can be passed via a resolve() value instead of throwing an untyped
 * reject()
 */
interface IExecResult {
  error?: child_process.ExecException;
  value?: { stdout: string; stderr: string };
}

/**
 * Promise wrapper for child_process.exec(). This returned Promise will never
 * reject -- instead if an Error occurs, it will be returned via the resolved
 * value.
 *
 * @param cmd The command to shell out and exec
 * @param pipeIO if true, will pipe all stdio the executing parent process
 */
const exec = async (
  cmd: string,
  pipeIO: boolean = false
): Promise<IExecResult> => {
  return new Promise<IExecResult>(resolve => {
    const child = child_process.exec(cmd, (error, stdout, stderr) => {
      return resolve({
        error: error ?? undefined,
        value: { stdout, stderr }
      });
    });
    if (pipeIO) {
      child.stdin?.pipe(process.stdin);
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    }
    return child;
  });
};

export interface IReconcileDependencies {
  exec: (commandToRun: string) => Promise<IExecResult>;

  writeFile: (path: string, contents: string) => void;

  test: (option: shelljs.TestOptions, path: string) => boolean;

  createRepositoryComponent: (
    execCmd: (commandToRun: string) => Promise<IExecResult>,
    absHldPath: string,
    repositoryName: string
  ) => Promise<IExecResult>;

  createServiceComponent: (
    execCmd: (commandToRun: string) => Promise<IExecResult>,
    absRepositoryInHldPath: string,
    pathBase: string
  ) => Promise<IExecResult>;

  createRingComponent: (
    execCmd: (commandToRun: string) => Promise<IExecResult>,
    svcPathInHld: string,
    ring: string
  ) => Promise<IExecResult>;

  addChartToRing: (
    execCmd: (commandToRun: string) => Promise<IExecResult>,
    ringPathInHld: string,
    serviceConfig: IBedrockServiceConfig
  ) => Promise<IExecResult>;

  createStaticComponent: (
    execCmd: (commandToRun: string) => Promise<IExecResult>,
    ringPathInHld: string
  ) => Promise<IExecResult>;

  createIngressRouteForRing: (
    ringPathInHld: string,
    serviceName: string,
    serviceConfig: IBedrockServiceConfig,
    middlewares: ITraefikMiddleware,
    ring: string
  ) => void;

  createMiddlewareForRing: (
    ringPathInHld: string,
    serviceName: string,
    ring: string
  ) => ITraefikMiddleware;
}

export const execute = async (
  repositoryName: string,
  hldPath: string,
  bedrockApplicationRepoPath: string,
  exitFn: (status: number) => Promise<void>
) => {
  try {
    validateInputs(repositoryName, hldPath, bedrockApplicationRepoPath);
    checkForFabrikate(shelljs.which);

    const absHldPath = testAndGetAbsPath(
      shelljs.test,
      logger.info,
      hldPath,
      "HLD"
    );

    const absBedrockPath = testAndGetAbsPath(
      shelljs.test,
      logger.info,
      bedrockApplicationRepoPath,
      "Bedrock Application"
    );

    const bedrockConfig = Bedrock(absBedrockPath);

    logger.info(
      `Attempting to reconcile HLD with services tracked in bedrock.yaml`
    );

    const reconcileDependencies: IReconcileDependencies = {
      addChartToRing,
      createIngressRouteForRing,
      createMiddlewareForRing,
      createRepositoryComponent,
      createRingComponent,
      createServiceComponent,
      createStaticComponent,
      exec: execAndLog,
      test: shelljs.test,
      writeFile: writeFileSync
    };

    await reconcileHld(
      reconcileDependencies,
      bedrockConfig,
      repositoryName,
      absHldPath
    );
    await exitFn(0);
  } catch (err) {
    logger.error(`An error occurred while reconciling HLD`);
    logger.error(err);
    await exitFn(1);
  }
};

export const commandDecorator = (command: commander.Command) => {
  buildCmd(command, decorator).action(
    async (
      repositoryName: string,
      hldPath: string,
      bedrockApplicationRepoPath: string
    ) => {
      // command will ensure that repositoryName,
      // hldPath and bedrockApplicationRepoPath are string type.
      await execute(
        repositoryName,
        hldPath,
        bedrockApplicationRepoPath,
        async (status: number) => {
          await exitCmd(logger, process.exit, status);
        }
      );
    }
  );
};

export const reconcileHld = async (
  dependencies: IReconcileDependencies,
  bedrockYaml: IBedrockFile,
  repositoryName: string,
  absHldPath: string
) => {
  const { services: managedServices, rings: managedRings } = bedrockYaml;

  // Create Repository Component if it doesn't exist.
  // In a pipeline, the repository component is the name of the application repository.
  await dependencies.createRepositoryComponent(
    dependencies.exec,
    absHldPath,
    repositoryName
  );

  // Repository in HLD ie /path/to/hld/repositoryName/
  const absRepositoryInHldPath = path.join(absHldPath, repositoryName);

  for (const [serviceRelPath, serviceConfig] of Object.entries(
    managedServices
  )) {
    const serviceName =
      serviceConfig.displayName || path.basename(serviceRelPath);

    // No name, cannot generate proper routes and middlewares
    if (serviceName === "." || !serviceName) {
      logger.warn(
        "Service displayName not provided or service path is `.` - not reconciling service"
      );
      continue;
    }

    logger.info(`Reconciling service: ${serviceName}`);

    // Utilizes fab add, which is idempotent.
    await dependencies.createServiceComponent(
      dependencies.exec,
      absRepositoryInHldPath,
      serviceName
    );

    // Create ring components.
    const svcPathInHld = path.join(absRepositoryInHldPath, serviceName);

    // If the ring component already exists, we do not attempt to create it.
    const ringsToCreate = Object.keys(managedRings)
      .map(ring => {
        return { ring, ringPathInHld: path.join(svcPathInHld, ring) };
      })
      .filter(({ ring, ringPathInHld }) => {
        const alreadyExists =
          dependencies.test("-e", ringPathInHld) && // path exists
          dependencies.test("-d", ringPathInHld); // path is a directory
        if (alreadyExists) {
          logger.info(
            `Ring component: ${ring} already exists, skipping ring generation.`
          );
        }
        return !alreadyExists;
      });

    // Will only loop over _existing_ rings in bedrock.yaml - does not cover the deletion case, ie: i remove a ring from bedrock.yaml
    for (const { ring, ringPathInHld } of ringsToCreate) {
      // Create the ring in the service.
      await dependencies.createRingComponent(
        dependencies.exec,
        svcPathInHld,
        ring
      );

      // Add the helm chart to the ring.
      await dependencies.addChartToRing(
        dependencies.exec,
        ringPathInHld,
        serviceConfig
      );

      // Create config directory, create static manifest directory.
      await dependencies.createStaticComponent(
        dependencies.exec,
        ringPathInHld
      );

      // Service explicitly requests no ingress-routes to be generated.
      if (serviceConfig.disableRouteScaffold) {
        logger.info(
          `Skipping ingress route generation for service ${serviceName}`
        );
        continue;
      }

      // Create middleware.
      const middlewares = dependencies.createMiddlewareForRing(
        ringPathInHld,
        serviceName,
        ring
      );

      // Create Ingress Route.
      dependencies.createIngressRouteForRing(
        ringPathInHld,
        serviceName,
        serviceConfig,
        middlewares,
        ring
      );
    }
  }
};

/**
 * Runs a command via `exec` and captures the results.
 * stdio is piped directly to parent, so outputs is streamed live as the child
 * process runs.
 *
 * @param commandToRun String version of the command that must be run
 * @throws {child_process.ExecException}
 */
export const execAndLog = async (
  commandToRun: string
): Promise<IExecResult> => {
  logger.info(`Running: ${commandToRun}`);
  const pipeOutputToCurrentShell = true;
  const result = await exec(commandToRun, pipeOutputToCurrentShell);
  if (result.error) {
    logger.error(`an error occurred executing command: \`${commandToRun}\``);
    throw result.error;
  }
  return result;
};

const createIngressRouteForRing = (
  ringPathInHld: string,
  serviceName: string,
  serviceConfig: IBedrockServiceConfig,
  middlewares: ITraefikMiddleware,
  ring: string
) => {
  const staticComponentPathInRing = path.join(ringPathInHld, "static");
  const ingressRoutePathInStaticComponent = path.join(
    staticComponentPathInRing,
    "ingress-route.yaml"
  );
  const ingressRoute = TraefikIngressRoute(
    serviceName,
    ring,
    serviceConfig.k8sBackendPort,
    {
      k8sBackend: serviceConfig.k8sBackend,
      middlewares: [
        middlewares.metadata.name,
        ...(serviceConfig.middlewares ?? [])
      ],
      pathPrefix: serviceConfig.pathPrefix,
      pathPrefixMajorVersion: serviceConfig.pathPrefixMajorVersion
    }
  );

  const routeYaml = yaml.safeDump(ingressRoute, {
    lineWidth: Number.MAX_SAFE_INTEGER
  });

  logger.info(
    `Writing IngressRoute YAML to '${ingressRoutePathInStaticComponent}'`
  );

  writeFileSync(ingressRoutePathInStaticComponent, routeYaml);
};

const createMiddlewareForRing = (
  ringPathInHld: string,
  serviceName: string,
  ring: string
): ITraefikMiddleware => {
  // Create Middlewares
  const staticComponentPathInRing = path.join(ringPathInHld, "static");
  const middlewaresPathInStaticComponent = path.join(
    staticComponentPathInRing,
    "middlewares.yaml"
  );

  const servicePrefix = `/${serviceName}`;
  const middlewares = TraefikMiddleware(serviceName, ring, [servicePrefix]);
  const middlewareYaml = yaml.safeDump(middlewares, {
    lineWidth: Number.MAX_SAFE_INTEGER
  });

  logger.info(
    `Writing Middlewares YAML to '${middlewaresPathInStaticComponent}'`
  );
  writeFileSync(middlewaresPathInStaticComponent, middlewareYaml);

  return middlewares;
};

export const createRepositoryComponent = async (
  execCmd: (commandToRun: string) => Promise<IExecResult>,
  absHldPath: string,
  repositoryName: string
) => {
  assertIsStringWithContent(absHldPath, "hld-path");
  assertIsStringWithContent(repositoryName, "repository-name");

  return execCmd(
    `cd ${absHldPath} && mkdir -p ${repositoryName} && fab add ${repositoryName} --path ./${repositoryName} --method local`
  ).catch(err => {
    logger.error(
      `error creating repository component '${repositoryName}' in path '${absHldPath}'`
    );
    throw err;
  });
};

export const createServiceComponent = async (
  execCmd: (commandToRun: string) => Promise<IExecResult>,
  absRepositoryInHldPath: string,
  serviceName: string
) => {
  // Fab add is idempotent.
  // mkdir -p does not fail if ${pathBase} does not exist.
  assertIsStringWithContent(absRepositoryInHldPath, "project-path");
  assertIsStringWithContent(serviceName, "service-name");

  return execCmd(
    `cd ${absRepositoryInHldPath} && mkdir -p ${serviceName} config && fab add ${serviceName} --path ./${serviceName} --method local --type component && touch ./config/common.yaml`
  ).catch(err => {
    logger.error(
      `error creating service component '${serviceName}' in path '${absRepositoryInHldPath}'`
    );
    throw err;
  });
};

export const createRingComponent = async (
  execCmd: (commandToRun: string) => Promise<IExecResult>,
  svcPathInHld: string,
  ring: string
) => {
  assertIsStringWithContent(svcPathInHld, "service-path");
  assertIsStringWithContent(ring, "ring-name");
  const createRingInSvcCommand = `cd ${svcPathInHld} && mkdir -p ${ring} config && fab add ${ring} --path ./${ring} --method local --type component && touch ./config/common.yaml`;

  return execCmd(createRingInSvcCommand).catch(err => {
    logger.error(
      `error creating ring component '${ring}' in path '${svcPathInHld}'`
    );
    throw err;
  });
};

export const addChartToRing = async (
  execCmd: (commandToRun: string) => Promise<IExecResult>,
  ringPathInHld: string,
  serviceConfig: IBedrockServiceConfig
) => {
  let addHelmChartCommand = "";
  const { chart } = serviceConfig.helm;
  if ("git" in chart) {
    let chartVersioning = "";
    if ("branch" in chart) {
      assertIsStringWithContent(chart.branch, "git-branch");
      chartVersioning = `--branch ${chart.branch}`;
    } else {
      assertIsStringWithContent(chart.sha, "git-sha");
      chartVersioning = `--version ${chart.sha}`;
    }
    assertIsStringWithContent(chart.git, "git-url");
    assertIsStringWithContent(chart.path, "git-path");
    addHelmChartCommand = `fab add chart --source ${chart.git} --path ${chart.path} ${chartVersioning} --type helm`;
  } else if ("repository" in chart) {
    assertIsStringWithContent(chart.repository, "helm-repo");
    assertIsStringWithContent(chart.chart, "helm-chart-name");
    addHelmChartCommand = `fab add chart --source ${chart.repository} --path ${chart.chart} --type helm`;
  }

  return execCmd(`cd ${ringPathInHld} && ${addHelmChartCommand}`).catch(err => {
    logger.error(
      `error adding helm chart for service-config ${JSON.stringify(
        serviceConfig
      )} to ring path '${ringPathInHld}'`
    );
    throw err;
  });
};

export const createStaticComponent = async (
  execCmd: (commandToRun: string) => Promise<IExecResult>,
  ringPathInHld: string
) => {
  assertIsStringWithContent(ringPathInHld, "ring-path");
  const createConfigAndStaticComponentCommand = `cd ${ringPathInHld} && mkdir -p config static && fab add static --path ./static --method local --type static && touch ./config/common.yaml`;

  return execCmd(createConfigAndStaticComponentCommand).catch(err => {
    logger.error(`error creating static component in path '${ringPathInHld}'`);
    throw err;
  });
};

export const validateInputs = (
  repositoryName: string,
  hldPath: string,
  bedrockApplicationRepoPath: string
) => {
  assertIsStringWithContent(repositoryName, "repository-name");
  assertIsStringWithContent(hldPath, "hld-path");
  assertIsStringWithContent(
    bedrockApplicationRepoPath,
    "bedrock-application-repo-path"
  );
};

export const testAndGetAbsPath = (
  test: (flags: TestOptions, path: string) => boolean,
  log: (logline: string) => void,
  possiblyRelativePath: string,
  pathType: string
): string => {
  const absPath = path.resolve(possiblyRelativePath);
  if (!test("-e", absPath) && !test("-d", absPath)) {
    throw Error(`Could not validate ${pathType} path.`);
  }
  log(`Found ${pathType} at ${absPath}`);
  return absPath;
};

export const checkForFabrikate = (which: (path: string) => string) => {
  const fabrikateInstalled = which("fab");
  if (fabrikateInstalled === "") {
    throw ReferenceError(
      `Fabrikate not installed. Please fetch and install the latest version: https://github.com/microsoft/fabrikate/releases`
    );
  }
};
