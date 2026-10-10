#include "../../../platform/adv/main/wifi_credentials.hpp"
#include "../../../platform/adv/main/adv_wifi.hpp"
#include "../../../platform/adv/main/wifi_security.h"
#include "nvs.h"
#include <cassert>
#include <cstring>
#include <cstdio>
#include <vector>
namespace {
bool ready = false, exists = false;
std::vector<unsigned char> record, pending;
int reads = 0, writes = 0, commits = 0, starts = 0, connects = 0;
esp_err_t read_error = ESP_OK, write_error = ESP_OK, commit_error = ESP_OK, start_error = ESP_OK, connect_error = ESP_OK;
advwifi::Ap restored;
void reset() { record.clear(); pending.clear(); exists = false; reads = writes = commits = starts = connects = 0; read_error = write_error = commit_error = start_error = connect_error = ESP_OK; }
void blank(const advwifi::Ap& ap, const advwifi::Password& p) { assert(!ap.ssid[0] && p.size == 0); for (auto c : p.bytes) assert(c == 0); }
}
extern "C" bool adv_wifi_protection_ready() { return ready; }
esp_err_t nvs_open(const char* ns, int mode, nvs_handle_t* h) { assert(!std::strcmp(ns, "adv_wifi")); *h = mode; return mode == NVS_READONLY && !exists ? ESP_ERR_NVS_NOT_FOUND : ESP_OK; }
void nvs_close(nvs_handle_t) { pending.clear(); }
esp_err_t nvs_get_blob(nvs_handle_t, const char* key, void* out, std::size_t* n) {
    assert(!std::strcmp(key, "credentials")); ++reads;
    if (read_error != ESP_OK) return read_error;
    if (!exists) return ESP_ERR_NVS_NOT_FOUND;
    if (*n < record.size()) return ESP_ERR_INVALID_SIZE;
    *n = record.size(); std::memcpy(out, record.data(), record.size()); return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t, const char*, const void* p, std::size_t n) { ++writes; if (write_error != ESP_OK) return write_error; pending.assign(static_cast<const unsigned char*>(p), static_cast<const unsigned char*>(p)+n); return ESP_OK; }
esp_err_t nvs_commit(nvs_handle_t) { ++commits; if (commit_error != ESP_OK) return commit_error; record = pending; exists = true; return ESP_OK; }
namespace advwifi {
bool protection_ready() { return ready; }
esp_err_t start() { ++starts; return start_error; }
esp_err_t connect_saved(const Ap& ap, const Password& p) { ++connects; assert(p.size == 8 || ap.auth == 0); assert(ap.channel == 0); for (auto b : ap.bssid) assert(b == 0); restored = ap; return connect_error; }
}
int main() {
    using namespace advwifi;
    Ap ap{}; std::strcpy(ap.ssid, "synthetic-test"); ap.auth = 3; ap.channel = 11; ap.bssid[0] = 42;
    Password p; for (int i=0; i<8; ++i) assert(p.append('x'));
    Ap out = ap; Password secret = p;
    assert(save_credentials(ap,p) == ESP_ERR_NOT_SUPPORTED && writes == 0);
    assert(load_credentials(out,secret) == ESP_ERR_NOT_SUPPORTED); blank(out,secret);
    assert(restore_at_boot(true,true) == ESP_ERR_NOT_SUPPORTED && starts == 0);
    ready = true;
    assert(load_credentials(out,secret) == ESP_ERR_NVS_NOT_FOUND); blank(out,secret);
    assert(restore_at_boot(true,true) == ESP_ERR_NVS_NOT_FOUND && starts == 0);
    assert(save_credentials(ap,p) == ESP_OK && writes == 1 && commits == 1 && record.size() == 99);
    assert(load_credentials(out,secret) == ESP_OK && secret.size == 8 && !std::strcmp(ap.ssid,out.ssid));
    assert(restore_at_boot(false,true) == ESP_OK && starts == 0);
    assert(restore_at_boot(true,false) == ESP_OK && starts == 0);
    assert(restore_at_boot(true,true) == ESP_OK && starts == 1 && connects == 1);
    auto good = record;
    record[0] = 2; auto unknown = record;
    assert(save_credentials(ap,p) == ESP_ERR_INVALID_STATE && record == unknown && writes == 1);
    assert(load_credentials(out,secret) == ESP_ERR_INVALID_STATE); blank(out,secret);
    assert(restore_at_boot(true,true) == ESP_ERR_INVALID_STATE && starts == 1);
    record = good; record.pop_back(); assert(save_credentials(ap,p) == ESP_ERR_INVALID_STATE && writes == 1);
    record = good; record[2] = 33; assert(save_credentials(ap,p) == ESP_ERR_INVALID_STATE);
    record = good; record[1] = 1; assert(save_credentials(ap,p) == ESP_ERR_INVALID_STATE);
    record = good; record[36] = 1; assert(save_credentials(ap,p) == ESP_ERR_INVALID_STATE);
    record = good; record[98] = 1; assert(save_credentials(ap,p) == ESP_ERR_INVALID_STATE);
    record = good; read_error = ESP_FAIL; assert(save_credentials(ap,p) == ESP_FAIL && writes == 1);
    assert(load_credentials(out,secret) == ESP_FAIL); blank(out,secret);
    read_error = ESP_OK; write_error = ESP_FAIL; assert(save_credentials(ap,p) == ESP_FAIL && commits == 1 && record == good);
    write_error = ESP_OK; commit_error = ESP_FAIL; assert(save_credentials(ap,p) == ESP_FAIL && commits == 2 && record == good);
    commit_error = ESP_OK; start_error = ESP_FAIL; assert(restore_at_boot(true,true) == ESP_FAIL && connects == 1 && record == good);
    start_error = ESP_OK; connect_error = ESP_FAIL; assert(restore_at_boot(true,true) == ESP_FAIL && record == good);
    connect_error = ESP_OK; ready = false; int previous = writes;
    assert(save_credentials(ap,p) == ESP_ERR_NOT_SUPPORTED && writes == previous);
    ready = true; reset(); ap.auth = 0; p.clear(); assert(save_credentials(ap,p) == ESP_OK);
    assert(restore_at_boot(true,true) == ESP_OK && connects == 1);
    p.append('x'); assert(save_credentials(ap,p) == ESP_ERR_INVALID_ARG);
    p.clear(); secret.clear();
    puts("Wi-Fi credentials: protection gate, blob validation, read/write/commit failures, boot restore and zeroing passed");
}
