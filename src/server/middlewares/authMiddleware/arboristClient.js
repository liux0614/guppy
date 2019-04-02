import fetch from 'node-fetch';
import config from '../../config';
import log from '../../logger';

class ArboristClient {
  constructor(arboristEndpoint) {
    this.baseEndpoint = arboristEndpoint;
  }

  listAuthorizedResources(jwt) {
    if (!jwt) {
      log.error('no JWT in the context; returning no resources');
      return Promise.resolve([]);
    }
    // Make request to arborist for list of resources with access
    const resourcesEndpoint = `${this.baseEndpoint}/auth/resources`;
    log.debug('[ArboristClient] listAuthorizedResources jwt: ', jwt);
    return fetch(
      resourcesEndpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user: { token: jwt } }),
      },
    ).then(
      response => response.json(),
      (err) => {
        log.error(err);
        return [];
      },
    );
  }
}

export default new ArboristClient(config.arboristEndpoint);
