cmake_minimum_required(VERSION 3.16)

project(cheryClaw VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

find_package(Qt6 REQUIRED COMPONENTS Quick QuickControls2 Widgets)

find_path(YAML_CPP_INCLUDE_DIR yaml-cpp/yaml.h)
find_library(YAML_CPP_LIBRARY yaml-cpp)
find_package_handle_standard_args(yaml-cpp REQUIRED_VARS YAML_CPP_INCLUDE_DIR YAML_CPP_LIBRARY)

qt_add_executable(cheryClaw
    src/cpp/main.cpp
    src/cpp/PetConfig.cpp
    src/cpp/PetConfig.h
)

qt_add_qml_module(cheryClaw
    URI cheryClaw
    VERSION 1.0
    QML_FILES
        src/qml/main.qml
        src/qml/components/AsciiPet.qml
        src/qml/components/TrayIcon.qml
        src/qml/pages/SettingsPage.qml
)

target_include_directories(cheryClaw PRIVATE ${YAML_CPP_INCLUDE_DIR})

target_link_libraries(cheryClaw PRIVATE
    Qt6::Quick
    Qt6::QuickControls2
    Qt6::Widgets
    ${YAML_CPP_LIBRARY}
)

set_target_properties(cheryClaw PROPERTIES
    WIN32_EXECUTABLE TRUE
    MACOSX_BUNDLE TRUE
)

install(TARGETS cheryClaw
    BUNDLE DESTINATION .
    RUNTIME DESTINATION bin
)