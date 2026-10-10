set(BOUNDED_SOURCES
    "${FIRMWARE_DIR}/execution_state.c"
    "${FIRMWARE_DIR}/detail_pager.c"
    "${FIRMWARE_DIR}/model.c"
    "${FIRMWARE_DIR}/json_lite.c"
)

foreach(source IN LISTS BOUNDED_SOURCES)
    file(READ "${source}" contents)
    if(contents MATCHES "(^|[^A-Za-z0-9_])(malloc|calloc|realloc|free)[ \t\r\n]*\\(")
        message(FATAL_ERROR "dynamic allocation call found in bounded MCU path: ${source}")
    endif()
endforeach()

file(READ "${FIRMWARE_DIR}/device_config.h" config_header)
if(NOT config_header MATCHES "#define MCU_MAX_FRAME_BYTES 2048")
    message(FATAL_ERROR "default maxFrameBytes must remain 2048")
endif()
if(NOT config_header MATCHES "#define MCU_EXECUTION_STEP_CAPACITY 16")
    message(FATAL_ERROR "default ExecutionStep capacity must remain 16")
endif()
if(NOT config_header MATCHES "#define MCU_DETAIL_PAGE_BUFFER_BYTES \(MCU_MAX_FRAME_BYTES \+ 1\)")
    message(FATAL_ERROR "detail page buffer must cover the complete frame plus NUL")
endif()
if(NOT config_header MATCHES "MCU_DETAIL_PAGE_BUFFER_BYTES != MCU_MAX_FRAME_BYTES \+ 1")
    message(FATAL_ERROR "unsafe detail page buffer overrides must fail at compile time")
endif()

file(READ "${FIRMWARE_DIR}/execution_state.h" execution_header)
if(NOT execution_header MATCHES "ExecutionStep steps\\[MCU_EXECUTION_STEP_CAPACITY\\]")
    message(FATAL_ERROR "ExecutionStep storage is not a compile-time fixed array")
endif()

file(READ "${FIRMWARE_DIR}/ws_lite.c" websocket_source)
if(NOT websocket_source MATCHES "turnDelta=%u")
    message(FATAL_ERROR "lite connection must explicitly declare turnDelta=0")
endif()

message(STATUS "firmware static budget checks passed")
