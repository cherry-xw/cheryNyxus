#include "lvgl.h"
#include "../../../../platform/adv/main/text_editor.h"
#include <cassert>
#include <cstring>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
LV_FONT_DECLARE(adv_font_basic);
int main(int argc,char**argv) {
    assert(argc==2); lv_init(); lv_display_t *d=lv_display_create(240,135); assert(d);
    lv_obj_t *ta=lv_textarea_create(lv_screen_active()); assert(ta);
    lv_obj_set_style_text_font(ta,&adv_font_basic,0); lv_textarea_set_max_length(ta,256);
    lv_textarea_set_text(ta,"你好世界"); lv_textarea_set_cursor_pos(ta,2);
    lv_textarea_add_text(ta,"A\n"); assert(!strcmp(lv_textarea_get_text(ta),"你好A\n世界"));
    lv_textarea_delete_char(ta); lv_textarea_delete_char(ta);
    lv_textarea_delete_char(ta); assert(!strcmp(lv_textarea_get_text(ta),"你世界"));
    lv_textarea_delete_char_forward(ta); assert(!strcmp(lv_textarea_get_text(ta),"你界"));
    char draft[1025]; assert(adv_text_save_draft(ta,draft)); lv_obj_delete(ta);
    ta=lv_textarea_create(lv_screen_active()); lv_textarea_set_text(ta,draft); assert(!strcmp(lv_textarea_get_text(ta),"你界"));
    std::string full(256,'a'); lv_textarea_set_max_length(ta,256); lv_textarea_set_text(ta,full.c_str());
    assert(!adv_text_can_insert(lv_textarea_get_text(ta),"中")); lv_textarea_add_text(ta,"b"); assert(strlen(lv_textarea_get_text(ta))==256);
    assert(!adv_text_apply(ta,{ADV_TEXT_CHAR,'b'}));
    assert(adv_text_apply(ta,{ADV_TEXT_BACKSPACE,0}));
    assert(adv_text_apply(ta,{ADV_TEXT_CHAR,'A'}));
    assert(strlen(lv_textarea_get_text(ta))==256);
    std::string emoji; for(unsigned i=0;i<256;++i) emoji+="😀";
    lv_textarea_set_text(ta,emoji.c_str());
    assert(strlen(lv_textarea_get_text(ta))==1024);
    assert(adv_text_save_draft(ta,draft)); assert(!adv_text_apply(ta,{ADV_TEXT_CHAR,'x'}));
    assert(adv_text_apply(ta,{ADV_TEXT_BACKSPACE,0}));
    assert(strlen(lv_textarea_get_text(ta))==1020);
    assert(adv_text_apply(ta,{ADV_TEXT_CHAR,'\n'}));
    assert(strlen(lv_textarea_get_text(ta))==1021);
    assert(adv_text_save_draft(ta,draft)); lv_obj_delete(ta);
    ta=lv_textarea_create(lv_screen_active()); lv_textarea_set_max_length(ta,256);
    lv_textarea_set_text(ta,draft); assert(!strcmp(lv_textarea_get_text(ta),draft));
    lv_textarea_set_cursor_pos(ta,0); assert(adv_text_apply(ta,{ADV_TEXT_DELETE,0}));
    assert(strlen(lv_textarea_get_text(ta))==1017);
    std::ifstream f(argv[1]); assert(f); std::string chars((std::istreambuf_iterator<char>(f)),{});
    chars += "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !~";
    const unsigned char *p=(const unsigned char*)chars.c_str(); unsigned count=0;
    while(*p) {
        uint32_t cp=*p++; if(cp=='\n') continue;
        if(cp>=0x80) { unsigned n=cp<0xe0?1:cp<0xf0?2:3; cp &= n==1?31:n==2?15:7; while(n--) cp=(cp<<6)|(*p++ &63); }
        lv_font_glyph_dsc_t glyph{}; assert(lv_font_get_glyph_dsc(&adv_font_basic,&glyph,cp,0)); assert(!glyph.is_placeholder); ++count;
    }
    lv_obj_delete(ta); lv_display_delete(d); lv_deinit();
    printf("real LVGL textarea UTF-8 cursor/delete, limits, draft recreation; %u coverage checks passed\n",count);
}
