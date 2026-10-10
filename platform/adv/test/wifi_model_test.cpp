#include "../../../platform/adv/main/wifi_model.hpp"
#include <cassert>
#include <cstdio>
int main() {
    advwifi::Password p;
    assert(p.valid(true) && !p.valid(false));
    assert(!p.append('\n') && !p.append(static_cast<char>(127)));
    for (char c = 32; c <= 94; ++c) assert(p.append(c));
    assert(p.size == 63 && !p.append('x') && p.bytes[63] == 0 && p.valid(false));
    p.erase(); assert(p.size == 62 && p.bytes[62] == 0);
    p.clear(); for (char c : p.bytes) assert(c == 0); assert(p.size == 0);
    for (int i = 0; i < 7; ++i) { p.append('x'); }
    assert(!p.valid(false));
    p.append('x'); assert(p.valid(false) && !p.valid(true));
    p.clear(); p.erase(); assert(p.size == 0);

    advwifi::Snapshot s; assert(s.count == 0 && s.phase == advwifi::Phase::Off);
    static_assert(sizeof(s.aps) / sizeof(s.aps[0]) == 12);
    puts("Wi-Fi model: password bounds, editing and wipe passed");
}
