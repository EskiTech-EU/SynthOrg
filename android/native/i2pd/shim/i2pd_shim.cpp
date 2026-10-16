/*
 * SynthOrg - C ABI around the i2pd router embedded in the Android app process.
 * Modeled on i2pd-android (app/jni/DaemonAndroid.cpp, i2pd_android.cpp):
 * Daemon.setDataDir -> Daemon.init(argc, argv) -> Daemon.start(); Daemon.stop();
 * network state via i2p::transport::transports.SetOnline.
 *
 * Compiled with -DANDROID (added by the NDK CMake toolchain), so "Daemon" is
 * i2p::util::DaemonAndroid::Instance() from daemon/Daemon.h.
 */
#include "i2pd_shim.h"

#include <atomic>
#include <exception>
#include <filesystem>
#include <mutex>
#include <string>
#include <system_error>
#include <vector>

#include "Daemon.h"
#include "Log.h"
#include "Transports.h"
#include "ClientContext.h"

namespace
{
	std::mutex g_Mutex;            // serializes start/stop and protects the fields below
	bool g_Inited = false;         // Daemon.init done (only once per process: i2pd's config cannot be re-parsed)
	bool g_Running = false;
	std::string g_DataDir;
	int g_SamPort = 0;
	std::atomic<int> g_Online{1};
	std::string g_LastError;       // returned by synthorg_i2pd_last_error

	std::mutex g_FatalMutex;       // ThrowFatal may be called from i2pd threads
	std::string g_Fatal;

	void OnFatal (const std::string& msg)
	{
		std::lock_guard<std::mutex> l(g_FatalMutex);
		if (g_Fatal.empty ()) g_Fatal = msg;
	}

	std::string TakeFatal ()
	{
		std::lock_guard<std::mutex> l(g_FatalMutex);
		std::string s; s.swap (g_Fatal);
		return s;
	}

	bool HasReseedCertificates (const std::string& datadir)
	{
		std::error_code ec;
		std::filesystem::path dir = std::filesystem::path (datadir) / "certificates" / "reseed";
		if (!std::filesystem::is_directory (dir, ec)) return false;
		for (const auto& e: std::filesystem::directory_iterator (dir, ec))
			if (e.path ().extension () == ".crt") return true;
		return false;
	}

	int Fail (int code, const std::string& msg)
	{
		g_LastError = msg;
		return code;
	}
}

extern "C" int synthorg_i2pd_start_with_port (const char* datadir, int sam_port)
{
	std::lock_guard<std::mutex> l(g_Mutex);
	g_LastError.clear ();
	if (g_Running) return SYNTHORG_I2PD_ALREADY_RUNNING;
	if (!datadir || !*datadir) return Fail (SYNTHORG_I2PD_ERR_ARGS, "datadir is empty");
	if (sam_port < 1 || sam_port > 65535) return Fail (SYNTHORG_I2PD_ERR_ARGS, "sam port out of range");

	const std::string dir (datadir);
	if (g_Inited)
	{
		// i2pd keeps its parsed options for the whole process: a restart must reuse them
		if (dir != g_DataDir) return Fail (SYNTHORG_I2PD_ERR_DATADIR, "datadir differs from the first start in this process");
		if (sam_port != g_SamPort) return Fail (SYNTHORG_I2PD_ERR_ARGS, "sam port differs from the first start in this process");
	}

	try
	{
		std::error_code ec;
		std::filesystem::create_directories (dir, ec);
		if (!std::filesystem::is_directory (dir, ec))
			return Fail (SYNTHORG_I2PD_ERR_DATADIR, "cannot create datadir " + dir);
		if (!HasReseedCertificates (dir))
			return Fail (SYNTHORG_I2PD_ERR_CERTIFICATES, "missing " + dir + "/certificates/reseed/*.crt");

		TakeFatal ();
		i2p::log::SetThrowFunction (OnFatal);

		if (!g_Inited)
		{
			const std::string port = std::to_string (sam_port);
			std::vector<std::string> args = {
				"synthorg-i2pd",
				"--datadir=" + dir,
				"--log=file",
				"--logfile=" + dir + "/i2pd.log",
				"--loglevel=warn",
				"--sam.enabled=true",
				"--sam.address=127.0.0.1",
				"--sam.port=" + port,
				"--http.enabled=false",
				"--httpproxy.enabled=false",
				"--socksproxy.enabled=false",
				"--bob.enabled=false",
				"--i2cp.enabled=false",
				"--i2pcontrol.enabled=false",
				"--upnp.enabled=false",
				"--reseed.verify=true",
			};
			std::vector<char*> argv;
			for (auto& a: args) argv.push_back (a.data ());
			argv.push_back (nullptr);

			Daemon.setDataDir (dir);
			if (!Daemon.init ((int)args.size (), argv.data ()))
				return Fail (SYNTHORG_I2PD_ERR_INIT, "i2pd init failed");
			g_Inited = true;
			g_DataDir = dir;
			g_SamPort = sam_port;
		}

		if (!Daemon.start ())
		{
			std::string f = TakeFatal ();
			return Fail (SYNTHORG_I2PD_ERR_TRANSPORTS, f.empty () ? "i2pd transports failed to start" : f);
		}
		g_Running = true;

		std::string f = TakeFatal ();
		if (!f.empty () || !i2p::client::context.GetSAMBridge ())
		{
			Daemon.stop ();
			g_Running = false;
			return Fail (SYNTHORG_I2PD_ERR_FATAL, f.empty () ? "SAM bridge not started" : f);
		}

		if (!g_Online.load ())
			i2p::transport::transports.SetOnline (false);
		return SYNTHORG_I2PD_OK;
	}
	catch (std::exception& ex)
	{
		return Fail (SYNTHORG_I2PD_ERR_EXCEPTION, ex.what ());
	}
	catch (...)
	{
		return Fail (SYNTHORG_I2PD_ERR_EXCEPTION, "unknown exception");
	}
}

extern "C" int synthorg_i2pd_start (const char* datadir)
{
	return synthorg_i2pd_start_with_port (datadir, SYNTHORG_I2PD_DEFAULT_SAM_PORT);
}

extern "C" void synthorg_i2pd_stop (void)
{
	std::lock_guard<std::mutex> l(g_Mutex);
	if (!g_Running) return;
	try { Daemon.stop (); } catch (...) {}
	g_Running = false;
}

extern "C" int synthorg_i2pd_sam_port (void)
{
	std::lock_guard<std::mutex> l(g_Mutex);
	return (g_Running && i2p::client::context.GetSAMBridge ()) ? g_SamPort : 0;
}

extern "C" void synthorg_i2pd_network_changed (int online)
{
	std::lock_guard<std::mutex> l(g_Mutex);
	g_Online = online ? 1 : 0;
	if (g_Running)
		i2p::transport::transports.SetOnline (online != 0);
}

extern "C" int synthorg_i2pd_is_running (void)
{
	std::lock_guard<std::mutex> l(g_Mutex);
	return g_Running ? 1 : 0;
}

extern "C" const char* synthorg_i2pd_last_error (void)
{
	return g_LastError.c_str ();
}
