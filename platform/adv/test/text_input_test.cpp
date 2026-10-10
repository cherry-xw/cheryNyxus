#include "../../../platform/adv/main/text_input.h"
#include <cassert>
#include <cstdio>
#include <string>
int main() {
    adv_text_modifiers_t m{};
    auto key = [&m](unsigned r, unsigned c, bool down=true) { return adv_text_decode({static_cast<uint8_t>(r), static_cast<uint8_t>(c), down}, &m); };
    unsigned printable=0;
    for (unsigned r=0;r<4;r++) for(unsigned c=0;c<14;c++) {
        m={}; auto e=key(r,c); if(e.kind==ADV_TEXT_CHAR) printable++;
        assert(key(r,c,false).kind==ADV_TEXT_NONE);
    }
    assert(printable==49);
    m={}; assert(key(2,2).character=='a');
    key(2,1); assert(key(2,2).character=='A'); key(2,1,false); assert(key(2,2).character=='a');
    key(2,0); assert(key(3,10).kind==ADV_TEXT_LEFT); assert(key(3,12).kind==ADV_TEXT_RIGHT);
    assert(key(2,11).kind==ADV_TEXT_UP); assert(key(3,11).kind==ADV_TEXT_DOWN);
    assert(key(0,0).kind==ADV_TEXT_EXIT); assert(key(0,13).kind==ADV_TEXT_DELETE);
    assert(key(1,1).character=='Q'); key(2,0,false);
    assert(key(2,11).character==';'); assert(key(0,13).kind==ADV_TEXT_BACKSPACE);
    assert(key(1,0).kind==ADV_TEXT_RETURN); assert(key(2,13).character=='\n');
    for(unsigned c=0;c<3;c++) { key(3,c); assert(key(2,2).kind==ADV_TEXT_NONE); key(3,c,false); }
    assert(key(4,0).kind==ADV_TEXT_NONE); assert(key(0,14).kind==ADV_TEXT_NONE);
    size_t b,c; assert(adv_text_measure("你好😀",&b,&c) && b==10 && c==3);
    for(const char *bad: {"\xc0\x80", "\xed\xa0\x80", "\xf4\x90\x80\x80", "\xe4", "\x80"}) assert(!adv_text_measure(bad,&b,&c));
    std::string ascii(256,'a'); assert(!adv_text_can_insert(ascii.c_str(),"b"));
    std::string emoji; for(int i=0;i<256;i++) emoji+="😀";
    assert(adv_text_can_insert("",emoji.c_str())); assert(!adv_text_can_insert(emoji.c_str(),"a"));
    assert(adv_text_can_insert("你好","\n"));
    puts("physical 56 positions/modifiers/navigation, UTF-8 and limits passed");
}
