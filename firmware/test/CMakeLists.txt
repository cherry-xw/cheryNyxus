cmake_minimum_required(VERSION 3.20)
project(cheryclaw_firmware_host_tests C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_executable(firmware_host_tests
    host_tests.c
    ../detail_pager.c
    ../execution_state.c
    ../json_lite.c
    ../model.c
    ../ui_stub.c
    ../ws_lite.c
    stubs/esp_stubs.c
)
target_include_directories(firmware_host_tests PRIVATE .. stubs)
target_compile_definitions(firmware_host_tests PRIVATE MCU_HOST_TEST=1)

add_library(firmware_device_static OBJECT
    ../main.c
    ../rpc.c
    ../ws_lite.c
)
target_include_directories(firmware_device_static PRIVATE .. stubs)

add_library(firmware_config_override_static OBJECT
    ../detail_pager.c
    ../execution_state.c
)
target_include_directories(firmware_config_override_static PRIVATE ..)
target_compile_definitions(firmware_config_override_static PRIVATE
    MCU_MAX_FRAME_BYTES=4096
    MCU_TIMELINE_PAGE_SIZE=5
    MCU_DETAIL_PAGE_CHARS=512
    MCU_EXECUTION_STEP_CAPACITY=24
)

if(MSVC)
    target_compile_options(firmware_host_tests PRIVATE /W4 /WX)
else()
    target_compile_options(firmware_host_tests PRIVATE -Wall -Wextra -Werror -Wpedantic)
    target_compile_options(firmware_device_static PRIVATE -Wall -Wextra -Werror -Wpedantic)
    target_compile_options(firmware_config_override_static PRIVATE -Wall -Wextra -Werror -Wpedantic)
endif()

enable_testing()
add_test(NAME firmware_host_tests COMMAND firmware_host_tests)
add_test(
    NAME firmware_static_budget
    COMMAND ${CMAKE_COMMAND}
        -DFIRMWARE_DIR=${CMAKE_CURRENT_LIST_DIR}/..
        -P ${CMAKE_CURRENT_LIST_DIR}/static_budget.cmake
)
