/*
 * SynthOrg - C ABI around the i2pd router embedded in the Android app process.
 *
 * The router runs inside the calling process (threads started by i2pd).
 * Only the SAM v3 bridge is enabled, bound to 127.0.0.1. Web console,
 * HTTP/SOCKS proxies, BOB, I2CP, I2PControl and UPnP are off.
 *
 * Before the first start, <datadir>/certificates must contain the folders
 * "reseed" and "family" shipped in out/certificates (see README.md).
 *
 * All functions are safe to call from any thread; start/stop are serialized.
 */
#ifndef SYNTHORG_I2PD_SHIM_H
#define SYNTHORG_I2PD_SHIM_H

#ifdef __cplusplus
extern "C" {
#endif

/* Return codes of synthorg_i2pd_start / synthorg_i2pd_start_with_port */
#define SYNTHORG_I2PD_OK                  0
#define SYNTHORG_I2PD_ALREADY_RUNNING     1
#define SYNTHORG_I2PD_ERR_ARGS           -1  /* datadir NULL/empty or port out of range */
#define SYNTHORG_I2PD_ERR_DATADIR        -2  /* datadir cannot be created, or differs from the one of the first start */
#define SYNTHORG_I2PD_ERR_CERTIFICATES   -3  /* <datadir>/certificates/reseed missing or empty */
#define SYNTHORG_I2PD_ERR_INIT           -4  /* i2pd init failed */
#define SYNTHORG_I2PD_ERR_TRANSPORTS     -5  /* NTCP2/SSU2 could not bind */
#define SYNTHORG_I2PD_ERR_FATAL          -6  /* i2pd reported a fatal error (e.g. SAM port busy); see last_error */
#define SYNTHORG_I2PD_ERR_EXCEPTION      -7  /* C++ exception; see last_error */

/* Default SAM TCP port used by synthorg_i2pd_start. */
#define SYNTHORG_I2PD_DEFAULT_SAM_PORT 7656

/* Starts the router with SAM on 127.0.0.1:7656. Returns 0 on success. */
int synthorg_i2pd_start(const char* datadir);

/* Same as synthorg_i2pd_start with an explicit SAM TCP port (1..65535). */
int synthorg_i2pd_start_with_port(const char* datadir, int sam_port);

/* Stops the router (blocks until i2pd threads are stopped). No-op if not running. */
void synthorg_i2pd_stop(void);

/* SAM TCP port if the router is running and the SAM bridge is up, otherwise 0. */
int synthorg_i2pd_sam_port(void);

/* Tell the router whether the device has network (1) or not (0),
 * e.g. from ConnectivityManager callbacks. */
void synthorg_i2pd_network_changed(int online);

/* 1 while the router is running, 0 otherwise. */
int synthorg_i2pd_is_running(void);

/* Last error message (static storage, valid until the next start call); "" if none. */
const char* synthorg_i2pd_last_error(void);

#ifdef __cplusplus
}
#endif

#endif /* SYNTHORG_I2PD_SHIM_H */
