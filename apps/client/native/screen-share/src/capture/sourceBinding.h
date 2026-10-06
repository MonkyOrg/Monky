#pragma once
#include <windows.h>
#include <stdbool.h>
#include <stdint.h>

typedef HANDLE(WINAPI *monky_open_process_fn)(DWORD, BOOL, DWORD);
bool monky_window_target_alive(void);
HWND monky_selected_window(void);
bool monky_window_identity_matches(HWND window, DWORD process_id, HANDLE process);
uint64_t monky_window_creation(void);
HANDLE monky_open_bound_game_process(monky_open_process_fn open_process, DWORD access, BOOL inherit, DWORD process_id);
bool monky_monitor_matches(HMONITOR monitor, const char *device_id, int method);
void monky_retire_source_binding(void);
