#pragma once
#include <mooncake.h>
#include <esp_err.h>
#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>

namespace adv {
// All runtime calls belong to the same task. No app instance exists until open().
using AppFactory = std::unique_ptr<mooncake::AppAbility> (*)();
using SaveBeforeExit = esp_err_t (*)();
// Borrowed strings must outlive Runtime; factories must not create shared driver owners.
struct AppEntry { const char* id; const char* name; AppFactory create; };
class Runtime {
public:
    bool register_app(AppEntry entry);
    bool open(const char* id);
    void update();
    esp_err_t restart_to_launcher(SaveBeforeExit save);
    std::size_t count() const { return count_; }
    const AppEntry* entry(std::size_t index) const;
    bool running() const { return active_ >= 0; }
private:
    std::array<AppEntry, 8> entries_{}; // Initial bounded registry, not a product app limit.
    std::size_t count_ = 0;
    int active_ = -1;
    mooncake::Mooncake manager_;
};
struct Preferences { uint8_t brightness = 80; bool auto_connect = true; };
// Only non-secret preferences. Credentials require a separate protected store.
esp_err_t load_preferences(Preferences& out);
esp_err_t save_preferences(const Preferences& value);
// Serial, non-secret plain-file service; mount root is borrowed and must outlive it.
using ChunkSource = esp_err_t (*)(void*, std::size_t, void*, std::size_t, std::size_t&);
class SdStore {
public:
    explicit SdStore(const char* root = "/sdcard") : root_(root) {}
    void set_mounted(bool mounted) { mounted_ = mounted; }
    bool mounted() const { return mounted_; }
    static constexpr std::size_t max_file = 64 * 1024, max_chunk = 1024;
    esp_err_t save(const char* key, std::size_t size, ChunkSource source, void* context);
    esp_err_t read(const char* key, std::size_t offset, void* out, std::size_t cap, std::size_t& bytes);
    esp_err_t read_previous(const char* key, std::size_t offset, void* out, std::size_t cap, std::size_t& bytes);
    esp_err_t read_resource(const char* relative, std::size_t offset, void* out, std::size_t cap, std::size_t& bytes);
private:
    esp_err_t path(const char* key, const char* suffix, char* out, std::size_t cap) const;
    esp_err_t read_version(const char* key, const char* suffix, std::size_t offset, void* out, std::size_t cap, std::size_t& bytes);
    const char* root_;
    bool mounted_ = false;
};
SdStore& sd_store(); // Shared product store; the hardware mount owner sets its state.
// Reads a bounded caller-sized resource chunk through the shared mount state.
esp_err_t read_sd_chunk(const char* relative, std::size_t offset,
                        void* output, std::size_t capacity, std::size_t& bytes);
}
