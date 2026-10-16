'use strict';
/**
 * Sharing the numbers of the model usage: kept for later, off for now.
 *
 * SHARE_ON false: nothing is asked, nothing is sent and the Consumi page says
 * nothing about it, whatever the address below, the setting
 * usage_share_endpoint or SYNTHORG_SHARE_ENDPOINT say. SYNTHORG_SHARE_ON=1
 * turns it on for a test. SHARE_ENDPOINT: where the numbers go when a user
 * shares them, the address of the service in share-worker/ once it is deployed.
 */
module.exports = { SHARE_ON: false, SHARE_ENDPOINT: '' };
