#include <windows.h>
#include <xinput.h>

// Xidi samples slot zero. Boxedwine mounts the launcher's MEMFS directory as D:.
DWORD WINAPI ReadPad(DWORD slot, XINPUT_STATE *state) {
    if (slot || !state) return ERROR_DEVICE_NOT_CONNECTED;
    HANDLE file = CreateFileW(L"D:\\fifa-pad.bin", GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) return ERROR_DEVICE_NOT_CONNECTED;
    DWORD bytes = 0;
    BOOL ok = ReadFile(file, state, sizeof(*state), &bytes, NULL);
    CloseHandle(file);
    return ok && bytes == sizeof(*state) ? ERROR_SUCCESS : ERROR_DEVICE_NOT_CONNECTED;
}

DWORD WINAPI VibratePad(DWORD slot, XINPUT_VIBRATION *value) {
    (void)value;
    return slot ? ERROR_DEVICE_NOT_CONNECTED : ERROR_NOT_SUPPORTED;
}
