#pragma once
#include <cstddef>
#include <cstdint>
namespace advwifi {
inline void wipe(void* p, std::size_t n) { volatile unsigned char* v = static_cast<volatile unsigned char*>(p); while (n--) *v++ = 0; }
struct Password {
    char bytes[64]{};
    std::size_t size = 0;
    bool append(char c) { if (size >= 63 || c < 32 || c > 126) return false; bytes[size++] = c; bytes[size] = 0; return true; }
    void erase() { if (size) bytes[--size] = 0; }
    void clear() { wipe(bytes, sizeof(bytes)); size = 0; }
    bool valid(bool open) const { return open ? size == 0 : size >= 8 && size <= 63; }
};
enum class Phase { Off, Idle, Scanning, Connecting, Associated, IpReady, Error, Stopping };
struct Ap { char ssid[33]{}; uint8_t bssid[6]{}; uint8_t channel = 0; int8_t rssi = 0; uint8_t auth = 0; };
struct Snapshot { Phase phase = Phase::Off; int error = 0; unsigned count = 0; Ap aps[12]{}; uint32_t ip = 0; };

}
