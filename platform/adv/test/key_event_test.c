#include <assert.h>
#include <stdio.h>
#include "../../../platform/adv/main/key_event.h"
int main(void) {
    bool seen[4][14] = {{false}};
    adv_key_t k;
    assert(!adv_decode_key(0, &k));
    assert(!adv_decode_key(0x80, &k));
    assert(!adv_decode_key(1, NULL));
    for (unsigned r = 0; r < 7; ++r) for (unsigned c = 0; c < 8; ++c) {
        uint8_t raw = r * 10 + c + 1;
        assert(adv_decode_key(raw | 0x80, &k));
        assert(k.pressed && k.row < 4 && k.col < 14);
        assert(!seen[k.row][k.col]); seen[k.row][k.col] = true;
        assert(adv_decode_key(raw, &k) && !k.pressed);
    }
    for (unsigned r = 0; r < 4; ++r) for (unsigned c = 0; c < 14; ++c) assert(seen[r][c]);
    for (unsigned code = 1; code < 128; ++code) {
        bool valid = (code - 1) / 10 < 7 && (code - 1) % 10 < 8;
        assert(adv_decode_key(code, &k) == valid);
    }
    puts("adv keyboard: all 56 positions, press/release and invalid events passed");
}
