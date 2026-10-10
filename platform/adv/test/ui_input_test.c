#include <assert.h>
#include <stdio.h>
#include "../../../platform/adv/main/ui_input.h"
int main(void) {
    bool fn = false;
    assert(adv_ui_decode((adv_key_t){2,13,true}, &fn) == ADV_ACCEPT);
    assert(adv_ui_decode((adv_key_t){2,13,false}, &fn) == ADV_NONE);
    assert(adv_ui_decode((adv_key_t){1,0,true}, &fn) == ADV_NEXT);
    assert(adv_ui_decode((adv_key_t){0,0,true}, &fn) == ADV_NONE);
    assert(adv_ui_decode((adv_key_t){2,0,true}, &fn) == ADV_NONE && fn);
    assert(adv_ui_decode((adv_key_t){0,0,true}, &fn) == ADV_EXIT);
    assert(adv_ui_decode((adv_key_t){2,11,true}, &fn) == ADV_PREVIOUS);
    assert(adv_ui_decode((adv_key_t){3,10,true}, &fn) == ADV_LEFT);
    assert(adv_ui_decode((adv_key_t){3,11,true}, &fn) == ADV_NEXT);
    assert(adv_ui_decode((adv_key_t){3,12,true}, &fn) == ADV_RIGHT);
    assert(adv_ui_decode((adv_key_t){2,0,false}, &fn) == ADV_NONE && !fn);
    assert(adv_ui_decode((adv_key_t){3,12,true}, &fn) == ADV_NONE);
    assert(adv_ui_decode((adv_key_t){4,0,true}, &fn) == ADV_NONE);
    assert(adv_ui_decode((adv_key_t){0,14,true}, &fn) == ADV_NONE);
    assert(adv_ui_decode((adv_key_t){0,0,true}, NULL) == ADV_NONE);
    puts("adv UI input: official positions, modifiers, releases and invalid events passed");
}
