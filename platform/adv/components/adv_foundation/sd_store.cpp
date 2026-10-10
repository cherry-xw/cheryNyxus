#include "adv_foundation.hpp"
#include <cstdio>
#include <cstring>
#include <cerrno>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <algorithm>

namespace adv {
SdStore& sd_store() { static SdStore store; return store; }
esp_err_t read_sd_chunk(const char* rel,std::size_t off,void* out,std::size_t cap,std::size_t& bytes) {
    return sd_store().read_resource(rel,off,out,cap,bytes);
}
esp_err_t SdStore::path(const char* key,const char* suffix,char* out,std::size_t cap) const {
    if (!key || !*key || std::strlen(key)>32 || !root_) return ESP_ERR_INVALID_ARG;
    for (const char* p=key; *p; ++p)
        if (!(*p>='a' && *p<='z') && !(*p>='0' && *p<='9') && *p!='_' && *p!='-') return ESP_ERR_INVALID_ARG;
    int n=std::snprintf(out,cap,"%s/userdata/%s.%s",root_,key,suffix);
    return n<0 || static_cast<std::size_t>(n)>=cap ? ESP_ERR_INVALID_SIZE : ESP_OK;
}
esp_err_t SdStore::read_version(const char* key,const char* suffix,std::size_t off,void* out,std::size_t cap,std::size_t& bytes) {
    bytes=0; char full[192];
    esp_err_t err=path(key,suffix,full,sizeof(full)); if (err!=ESP_OK) return err;
    if (!out || !cap || off>max_file) return ESP_ERR_INVALID_ARG;
    if (cap>max_chunk) return ESP_ERR_INVALID_SIZE;
    if (!mounted_) return ESP_ERR_INVALID_STATE;
    struct stat st{};
    if (stat(full,&st)) return errno==ENOENT ? ESP_ERR_NOT_FOUND : ESP_FAIL;
    if (!S_ISREG(st.st_mode) || st.st_size<0 || static_cast<std::size_t>(st.st_size)>max_file) return ESP_ERR_INVALID_SIZE;
    FILE* f=std::fopen(full,"rb"); if (!f) return ESP_FAIL;
    if (std::fseek(f,static_cast<long>(off),SEEK_SET)) err=ESP_FAIL;
    else { bytes=std::fread(out,1,cap,f); if (std::ferror(f)) err=ESP_FAIL; }
    if (std::fclose(f)) err=ESP_FAIL;
    if (err!=ESP_OK) bytes=0;
    return err;
}
esp_err_t SdStore::read(const char* k,std::size_t o,void* b,std::size_t c,std::size_t& n) { return read_version(k,"dat",o,b,c,n); }
esp_err_t SdStore::read_previous(const char* k,std::size_t o,void* b,std::size_t c,std::size_t& n) { return read_version(k,"bak",o,b,c,n); }
static uint32_t crc_update(uint32_t crc,const unsigned char* b,std::size_t n) {
    while (n--) { crc^=*b++; for (int i=0;i<8;++i) crc=(crc>>1)^((crc&1)?0xedb88320u:0); }
    return crc;
}
// I/O errors are not absence. The FAT mount is trusted, not a hostile POSIX tree.
static esp_err_t exists(const char* p,bool& present) {
    struct stat st{}; if (!stat(p,&st)) { present=true; return S_ISREG(st.st_mode)?ESP_OK:ESP_ERR_INVALID_STATE; }
    present=false; return errno==ENOENT?ESP_OK:ESP_FAIL;
}
esp_err_t SdStore::save(const char* key,std::size_t size,ChunkSource source,void* context) {
    char current[192],previous[192],temp[192],dir[192];
    esp_err_t err=path(key,"dat",current,sizeof(current)); if (err!=ESP_OK) return err;
    if (!source) return ESP_ERR_INVALID_ARG;
    if (size>max_file) return ESP_ERR_INVALID_SIZE;
    if (!mounted_) return ESP_ERR_INVALID_STATE;
    if ((err=path(key,"bak",previous,sizeof(previous)))!=ESP_OK || (err=path(key,"tmp",temp,sizeof(temp)))!=ESP_OK) return err;
    int length=std::snprintf(dir,sizeof(dir),"%s/userdata",root_);
    if (length<0 || static_cast<std::size_t>(length)>=sizeof(dir)) return ESP_ERR_INVALID_SIZE;
    if (mkdir(dir,0770) && errno!=EEXIST) return ESP_FAIL;
    struct stat st{}; if (stat(dir,&st) || !S_ISDIR(st.st_mode)) return ESP_FAIL;
    bool has_current=false,has_previous=false,has_temp=false;
    if ((err=exists(current,has_current))!=ESP_OK || (err=exists(previous,has_previous))!=ESP_OK || (err=exists(temp,has_temp))!=ESP_OK) return err;
    if (has_temp || (!has_current && has_previous)) return ESP_ERR_INVALID_STATE;
    int fd=::open(temp,O_WRONLY|O_CREAT|O_EXCL,0660); if (fd<0) return ESP_FAIL;
    FILE* f=fdopen(fd,"wb"); if (!f) { ::close(fd); return ESP_FAIL; }
    unsigned char buffer[512]; uint32_t crc=0xffffffffu;
    for (std::size_t off=0;off<size;) {
        std::size_t cap=std::min(sizeof(buffer),size-off),n=0;
        err=source(context,off,buffer,cap,n);
        if (err!=ESP_OK) break;
        if (!n || n>cap) { err=ESP_ERR_INVALID_SIZE; break; }
        if (std::fwrite(buffer,1,n,f)!=n) { err=ESP_FAIL; break; }
        crc=crc_update(crc,buffer,n); off+=n;
    }
    if (err==ESP_OK && (std::fflush(f) || fsync(fileno(f)))) err=ESP_FAIL;
    if (std::fclose(f)) err=ESP_FAIL;
    if (err!=ESP_OK) return err; // Leave temporary data for explicit reconciliation.
    f=std::fopen(temp,"rb"); if (!f) return ESP_FAIL;
    std::size_t total=0; uint32_t check=0xffffffffu;
    while (true) { std::size_t n=std::fread(buffer,1,sizeof(buffer),f); total+=n; check=crc_update(check,buffer,n); if (total>size || n<sizeof(buffer)) break; }
    if (std::ferror(f) || total!=size || check!=crc) err=ESP_FAIL;
    if (std::fclose(f)) err=ESP_FAIL;
    if (err!=ESP_OK) return err;
    if (has_current) {
        if (has_previous && std::remove(previous)) return ESP_FAIL;
        if (std::rename(current,previous)) return ESP_FAIL;
    }
    return std::rename(temp,current)==0 ? ESP_OK : ESP_FAIL;
}
}
