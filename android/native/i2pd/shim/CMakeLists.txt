# Builds, with the same flags as i2pd's own libraries:
#   libi2pddaemon.a  - i2pd daemon/ sources (Daemon, HTTPServer, I2PControl, UPnP stub),
#                      compiled with -DANDROID so Daemon = i2p::util::DaemonAndroid
#   libi2pd_shim.a   - SynthOrg C ABI (i2pd_shim.h)
# Configured by ../build.sh with the NDK toolchain file.
cmake_minimum_required(VERSION 3.22)
project(synthorg_i2pd_shim LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT I2PD_SRC OR NOT BOOST_PREFIX OR NOT OPENSSL_PREFIX)
  message(FATAL_ERROR "I2PD_SRC, BOOST_PREFIX and OPENSSL_PREFIX are required")
endif()

set(I2PD_INCLUDES
  ${I2PD_SRC}/libi2pd
  ${I2PD_SRC}/libi2pd_client
  ${I2PD_SRC}/i18n
  ${I2PD_SRC}/daemon)

add_library(libi2pddaemon STATIC
  ${I2PD_SRC}/daemon/Daemon.cpp
  ${I2PD_SRC}/daemon/HTTPServer.cpp
  ${I2PD_SRC}/daemon/I2PControl.cpp
  ${I2PD_SRC}/daemon/I2PControlHandlers.cpp
  ${I2PD_SRC}/daemon/UPnP.cpp)
set_target_properties(libi2pddaemon PROPERTIES PREFIX "")

add_library(libi2pd_shim STATIC ${CMAKE_CURRENT_SOURCE_DIR}/i2pd_shim.cpp)
set_target_properties(libi2pd_shim PROPERTIES PREFIX "")

foreach(t libi2pddaemon libi2pd_shim)
  target_include_directories(${t} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${I2PD_INCLUDES})
  target_include_directories(${t} SYSTEM PRIVATE ${BOOST_PREFIX}/include ${OPENSSL_PREFIX}/include)
  target_compile_definitions(${t} PRIVATE OPENSSL_SUPPRESS_DEPRECATED)
  target_compile_options(${t} PRIVATE -Wall -Wno-unused-parameter -Wno-uninitialized
    -Wno-unused-const-variable -Wno-overloaded-virtual -Wno-c99-extensions)
endforeach()
