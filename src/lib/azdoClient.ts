// imports
import { getPersonalAccessTokenHandler, WebApi } from "azure-devops-node-api";
import { IBuildApi } from "azure-devops-node-api/BuildApi";
import { RestClient } from "typed-rest-client";
import { Config } from "../config";
import { logger } from "../logger";
import { IAzureDevOpsOpts } from "./git";

// Module state Variables
let connection: WebApi | undefined;
let restApi: RestClient | undefined;
let buildApi: IBuildApi | undefined;

/**
 * Return a well-formed AzDo organization URL.
 * @param orgName Azure DevOps organization name.
 * @returns fully qualified AzDo Url for the organization
 */
export const azdoUrl = (orgName: string): string =>
  `https://dev.azure.com/${orgName}`;

/**
 * Creates AzDo `azure-devops-node-api.WebApi` with `org` and `token`
 * @param opts optionally override spk config Azure DevOps access options
 * @returns AzDo `WebApi` object
 */
export const getWebApi = async (
  opts: IAzureDevOpsOpts = {}
): Promise<WebApi> => {
  if (typeof connection !== "undefined") {
    return connection;
  }

  // Load config from opts and fallback to spk config
  const config = Config();
  const {
    personalAccessToken = config.azure_devops &&
      config.azure_devops.access_token,
    orgName = config.azure_devops && config.azure_devops.org
  } = opts;

  // PAT and devops URL are required
  if (typeof personalAccessToken === "undefined") {
    throw Error(
      `Unable to parse Azure DevOps Personal Access Token (azure_devops.access_token) from spk config`
    );
  }

  if (typeof orgName === "undefined") {
    throw Error(
      `Unable to parse Azure DevOps Organization name (azure_devops.org) from spk config`
    );
  }

  const orgUrl = azdoUrl(orgName);

  logger.debug(
    `getWebApi with org url: ${orgUrl} and token: ${personalAccessToken}`
  );

  const authHandler = getPersonalAccessTokenHandler(personalAccessToken);
  connection = new WebApi(orgUrl, authHandler);

  return connection;
};

/**
 * Creates AzDo `azure-devops-node-api.WebApi.RestClient` with `org` and `token and returns `RestClient`
 * @param opts optionally override spk config Azure DevOps access options
 * @returns AzDo `RestClient` object
 */
export const getRestClient = async (
  opts: IAzureDevOpsOpts = {}
): Promise<RestClient> => {
  if (typeof restApi !== "undefined") {
    return restApi;
  }

  const webApi = await getWebApi(opts);
  restApi = webApi.rest;
  return restApi;
};

/**
 * Creates AzDo `azure-devops-node-api.WebApi.IBuildApi` with `org` and `token and returns `RestClient`
 * @param opts optionally override spk config Azure DevOps access options
 * @returns AzDo `IBuildApi` object
 */
export const getBuildApi = async (
  opts: IAzureDevOpsOpts = {}
): Promise<IBuildApi> => {
  if (typeof buildApi !== "undefined") {
    return buildApi;
  }

  const webApi = await getWebApi(opts);
  buildApi = await webApi.getBuildApi();
  return buildApi;
};
