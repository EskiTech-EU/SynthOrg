/* Link smoke test: references every shim entry point so the linker must
 * resolve the whole i2pd + Boost + OpenSSL dependency graph.
 * On a device/emulator:  smoke <datadir> [seconds]
 * (datadir must contain certificates/reseed; the router stays up for [seconds], default 0) */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include "i2pd_shim.h"

int main(int argc, char** argv)
{
	if (argc < 2) {
		printf("usage: %s <datadir> [seconds]\n", argv[0]);
		return 2;
	}
	int rc = synthorg_i2pd_start(argv[1]);
	printf("start=%d err='%s' running=%d sam_port=%d\n", rc, synthorg_i2pd_last_error(),
	       synthorg_i2pd_is_running(), synthorg_i2pd_sam_port());
	fflush(stdout);
	synthorg_i2pd_network_changed(1);
	if (argc > 2) sleep((unsigned)atoi(argv[2]));
	synthorg_i2pd_stop();
	printf("stopped running=%d sam_port=%d\n", synthorg_i2pd_is_running(), synthorg_i2pd_sam_port());
	(void)synthorg_i2pd_start_with_port;
	return rc == 0 ? 0 : 1;
}
