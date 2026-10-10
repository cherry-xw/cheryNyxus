// Host adapters exercise runtime logic with real Mooncake, not real NVS/SD hardware.
#include "adv_foundation.hpp"
#include <nvs.h>
#include <cassert>
#include <cstring>
#include <cstdio>
#include <vector>
#include <filesystem>
#include <string>
#include <cstdlib>
#include <algorithm>
static int made=0,opened=0,closed=0,destroyed=0,restarts=0;
static bool fail_commit=false;
static esp_err_t read_error=ESP_OK;
static std::vector<unsigned char> saved,pending;
void esp_restart() { ++restarts; }
esp_err_t nvs_open(const char*,int mode,nvs_handle_t* h) { if(mode==NVS_READONLY && read_error!=ESP_OK)return read_error;*h=1;return ESP_OK; }
void nvs_close(nvs_handle_t) { pending.clear(); }
esp_err_t nvs_get_blob(nvs_handle_t,const char*,void* p,std::size_t* n) {
 if(saved.empty()) return ESP_ERR_NVS_NOT_FOUND;
 if(*n<saved.size()) return ESP_ERR_INVALID_SIZE;
 std::memcpy(p,saved.data(),saved.size());*n=saved.size();return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t,const char*,const void* p,std::size_t n) {
 auto b=static_cast<const unsigned char*>(p);pending.assign(b,b+n);return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t) { if(fail_commit)return ESP_FAIL;saved=pending;return ESP_OK; }
class Demo final: public mooncake::AppAbility {
public:
 Demo(){++made;} ~Demo(){++destroyed;}
 void onOpen() override {++opened;}
 void onClose() override {++closed;}
};
static std::unique_ptr<mooncake::AppAbility> create(){return std::make_unique<Demo>();}
static esp_err_t source(void* context,std::size_t off,void* out,std::size_t cap,std::size_t& n) {
 auto& data=*static_cast<std::string*>(context);n=std::min(cap,data.size()-off);std::memcpy(out,data.data()+off,n);return ESP_OK;
}
int main(){
 adv::Runtime r;assert(r.register_app({"demo","Demo",create}));
 assert(!r.register_app({"demo","Duplicate",create}));assert(made==0);
 assert(!r.open("unknown"));assert(r.open("demo"));r.update();
 assert(made==1 && opened==1 && r.running());assert(!r.open("demo"));
 assert(r.restart_to_launcher(nullptr)==ESP_ERR_INVALID_ARG);
 assert(r.restart_to_launcher([]{return ESP_FAIL;})==ESP_FAIL);
 assert(restarts==0 && r.running() && closed==0);
 r.restart_to_launcher([]{return ESP_OK;});
 assert(restarts==1 && !r.running() && closed==1 && destroyed==1);
 adv::Preferences p;assert(adv::load_preferences(p)==ESP_OK && p.brightness==80);
 p.brightness=37;p.auto_connect=false;assert(adv::save_preferences(p)==ESP_OK);
 adv::Preferences restored;assert(adv::load_preferences(restored)==ESP_OK);
 assert(restored.brightness==37 && !restored.auto_connect);
 fail_commit=true;p.brightness=41;assert(adv::save_preferences(p)==ESP_FAIL);
 assert(adv::load_preferences(restored)==ESP_OK && restored.brightness==37);
 saved[0]=99;assert(adv::load_preferences(restored)==ESP_ERR_INVALID_STATE);
 auto corrupt=saved;assert(adv::save_preferences(p)==ESP_ERR_INVALID_STATE && saved==corrupt);
 saved={1,0,1};restored=adv::Preferences{};
 assert(adv::load_preferences(restored)==ESP_ERR_INVALID_STATE && restored.brightness==80);
 assert(adv::save_preferences(p)==ESP_ERR_INVALID_STATE && saved[1]==0);
 saved={1,80,1};read_error=ESP_FAIL;
 assert(adv::save_preferences(p)==ESP_FAIL && saved[1]==80);read_error=ESP_OK;
 saved={1,80};assert(adv::save_preferences(p)==ESP_ERR_INVALID_STATE && saved.size()==2);
 saved={1,80,1};p.brightness=0;assert(adv::save_preferences(p)==ESP_ERR_INVALID_ARG);
 fail_commit=false;p.brightness=10;assert(adv::save_preferences(p)==ESP_OK);
 p.brightness=100;assert(adv::save_preferences(p)==ESP_OK);
 char b[8];std::size_t n=99;
 for(auto path:{"../x","/absolute","a/../x","a//x","a/","a\\b"})
  assert(adv::read_sd_chunk(path,0,b,sizeof(b),n)==ESP_ERR_INVALID_ARG && n==0);
 auto scratch=std::getenv("TMPDIR");assert(scratch);
 std::string templ=std::string(scratch)+"/adv-sd-XXXXXX";
 std::vector<char> folder(templ.begin(),templ.end());folder.push_back(0);assert(mkdtemp(folder.data()));
 std::string root=folder.data();adv::SdStore store(root.c_str());std::string data(1500,'a');
 assert(store.save("draft",data.size(),source,&data)==ESP_ERR_INVALID_STATE);
 store.set_mounted(true);
 for(auto key:{"../x","a/b","UPPER","a.b","","a\\b"}) assert(store.save(key,1,source,&data)==ESP_ERR_INVALID_ARG);
 assert(store.save("draft",adv::SdStore::max_file+1,source,&data)==ESP_ERR_INVALID_SIZE);
 assert(store.read("missing",0,b,sizeof(b),n)==ESP_ERR_NOT_FOUND && n==0);
 assert(store.save("draft",data.size(),source,&data)==ESP_OK);
 char chunk[1024];assert(store.read("draft",1496,chunk,sizeof(chunk),n)==ESP_OK && n==4);
 assert(store.read("draft",1500,chunk,sizeof(chunk),n)==ESP_OK && n==0);
 assert(store.read("draft",0,chunk,1025,n)==ESP_ERR_INVALID_SIZE);
 data="second";assert(store.save("draft",data.size(),source,&data)==ESP_OK);
 assert(store.read_previous("draft",0,chunk,sizeof(chunk),n)==ESP_OK && n==1024 && chunk[0]=='a');
 assert(store.read("draft",0,chunk,sizeof(chunk),n)==ESP_OK && n==6 && !std::memcmp(chunk,"second",6));
 data="third";assert(store.save("draft",data.size(),source,&data)==ESP_OK);
 assert(store.read_previous("draft",0,chunk,sizeof(chunk),n)==ESP_OK && n==6 && !std::memcmp(chunk,"second",6));
 assert(store.save("empty",0,source,&data)==ESP_OK);
 assert(store.read("empty",0,chunk,sizeof(chunk),n)==ESP_OK && n==0);
 assert(store.save("failed",10,[](void*,std::size_t,void*,std::size_t,std::size_t&){return ESP_FAIL;},nullptr)==ESP_FAIL);
 assert(store.save("failed",data.size(),source,&data)==ESP_ERR_INVALID_STATE);
 assert(store.save("short",10,[](void*,std::size_t,void*,std::size_t,std::size_t& n){n=0;return ESP_OK;},nullptr)==ESP_ERR_INVALID_SIZE);
 std::filesystem::rename(root+"/userdata/draft.dat",root+"/orphan.dat");
 assert(store.save("draft",data.size(),source,&data)==ESP_ERR_INVALID_STATE);
 assert(store.read("draft",0,chunk,sizeof(chunk),n)==ESP_ERR_NOT_FOUND);
 assert(store.read_previous("draft",0,chunk,sizeof(chunk),n)==ESP_OK && n==6);
 store.set_mounted(false);assert(store.read("draft",0,chunk,sizeof(chunk),n)==ESP_ERR_INVALID_STATE && n==0);
 store.set_mounted(true);assert(store.read_resource("orphan.dat",0,chunk,sizeof(chunk),n)==ESP_OK && n==5);
 std::string absent=root+"/absent";adv::SdStore unavailable(absent.c_str());unavailable.set_mounted(true);
 assert(unavailable.save("draft",1,source,&data)==ESP_FAIL);
 data.assign(adv::SdStore::max_file,'z');assert(store.save("limit",data.size(),source,&data)==ESP_OK);
 std::size_t total=0;while(total<data.size()) {assert(store.read("limit",total,chunk,sizeof(chunk),n)==ESP_OK && n>0);for(std::size_t i=0;i<n;++i)assert(chunk[i]=='z');total+=n;}
 assert(total==data.size());std::filesystem::remove_all(root);
 std::puts("PASS lifecycle, settings overwrite protection/brightness, SD bounded persistence/previous/failure/recovery (host SDK adapters, ordinary filesystem)");
}
