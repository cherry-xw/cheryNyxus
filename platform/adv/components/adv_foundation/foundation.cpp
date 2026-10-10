#include "adv_foundation.hpp"
#include <nvs.h>
#include <esp_system.h>
#include <cstring>
#include <cstdio>
#include <climits>
#include <cerrno>

namespace adv {
bool Runtime::register_app(AppEntry e) {
    if (running() || !e.id || !*e.id || !e.name || !e.create || count_ == entries_.size()) return false;
    for (std::size_t i=0; i<count_; ++i) if (!std::strcmp(entries_[i].id,e.id)) return false;
    entries_[count_++]=e; return true;
}
const AppEntry* Runtime::entry(std::size_t i) const { return i<count_ ? &entries_[i] : nullptr; }
bool Runtime::open(const char* id) {
    if (!id || running()) return false;
    for (std::size_t i=0; i<count_; ++i) {
        if (std::strcmp(entries_[i].id,id)) continue;
        auto app=entries_[i].create(); if (!app) return false;
        int handle=manager_.installApp(std::move(app));
        manager_.update();
        if (!manager_.openApp(handle)) { manager_.uninstallApp(handle); return false; }
        active_=handle; manager_.update(); return true;
    }
    return false;
}
void Runtime::update() { manager_.update(); }
esp_err_t Runtime::restart_to_launcher(SaveBeforeExit save) {
    // A caller-provided quiesce/save hook is mandatory. Failure must not lose data.
    if (!save) return ESP_ERR_INVALID_ARG;
    esp_err_t err=save(); if (err!=ESP_OK) return err;
    if (running()) {
        if (!manager_.closeApp(active_)) return ESP_FAIL;
        manager_.update();
        if (!manager_.uninstallApp(active_)) return ESP_FAIL;
        manager_.update();
        active_=-1;
    }
    esp_restart(); return ESP_FAIL;
}
struct StoredPreferences { uint8_t version, brightness, auto_connect; };
esp_err_t load_preferences(Preferences& out) {
    nvs_handle_t h; esp_err_t err=nvs_open("adv_system",NVS_READONLY,&h);
    if (err==ESP_ERR_NVS_NOT_FOUND) { out=Preferences{}; return ESP_OK; }
    if (err!=ESP_OK) return err;
    StoredPreferences v{}; std::size_t n=sizeof(v);
    err=nvs_get_blob(h,"preferences",&v,&n); nvs_close(h);
    if (err==ESP_ERR_NVS_NOT_FOUND) { out=Preferences{}; return ESP_OK; }
    if (err!=ESP_OK) return err;
    if (n!=sizeof(v) || v.version!=1 || v.brightness<10 || v.brightness>100 || v.auto_connect>1) return ESP_ERR_INVALID_STATE;
    out.brightness=v.brightness; out.auto_connect=v.auto_connect!=0; return ESP_OK;
}
esp_err_t save_preferences(const Preferences& value) {
    if (value.brightness<10 || value.brightness>100) return ESP_ERR_INVALID_ARG;
    Preferences existing;
    esp_err_t readable=load_preferences(existing);
    if (readable!=ESP_OK) return readable; // Never overwrite unreadable/unknown records.
    nvs_handle_t h; esp_err_t err=nvs_open("adv_system",NVS_READWRITE,&h);
    if (err!=ESP_OK) return err;
    StoredPreferences v{1,value.brightness,static_cast<uint8_t>(value.auto_connect)};
    err=nvs_set_blob(h,"preferences",&v,sizeof(v));
    if (err==ESP_OK) err=nvs_commit(h);
    nvs_close(h); return err;
}
esp_err_t SdStore::read_resource(const char* rel,std::size_t offset,void* out,std::size_t cap,std::size_t& bytes) {
    bytes=0;
    if (!rel || !*rel || *rel=='/' || !out || cap==0 || offset>LONG_MAX) return ESP_ERR_INVALID_ARG;
    // Restrict paths to plain relative components; no traversal or alternate separators.
    for (const char* p=rel; *p;) {
        const char* end=std::strchr(p,'/'); std::size_t n=end ? static_cast<std::size_t>(end-p) : std::strlen(p);
        if (!n || (n==1 && *p=='.') || (n==2 && p[0]=='.' && p[1]=='.')) return ESP_ERR_INVALID_ARG;
        for (std::size_t i=0;i<n;++i) if (p[i]=='\\' || p[i]==':' || static_cast<unsigned char>(p[i])<32) return ESP_ERR_INVALID_ARG;
        if (!end) break;
        p=end+1; if (!*p) return ESP_ERR_INVALID_ARG;
    }
    if (cap>max_chunk) return ESP_ERR_INVALID_SIZE;
    if (!root_) return ESP_ERR_INVALID_ARG;
    if (!mounted_) return ESP_ERR_INVALID_STATE;
    char path[192]; int length=std::snprintf(path,sizeof(path),"%s/%s",root_,rel);
    if (length<0 || static_cast<std::size_t>(length)>=sizeof(path)) return ESP_ERR_INVALID_SIZE;
    FILE* f=std::fopen(path,"rb"); if (!f) return errno==ENOENT ? ESP_ERR_NOT_FOUND : ESP_FAIL;
    esp_err_t err=ESP_OK;
    if (std::fseek(f,static_cast<long>(offset),SEEK_SET)) err=ESP_FAIL;
    else { bytes=std::fread(out,1,cap,f); if (std::ferror(f)) err=ESP_FAIL; }
    if (std::fclose(f)!=0) err=ESP_FAIL;
    if (err!=ESP_OK) bytes=0;
    return err;
}
}
