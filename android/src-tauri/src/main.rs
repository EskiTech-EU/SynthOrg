// The same app as on the phone, in a window: for trying the interface on the computer.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    synthorg_phone_lib::run()
}
