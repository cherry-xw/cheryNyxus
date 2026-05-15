import QtQuick
import QtQuick.Controls
import QtQuick.Window
import "components"
import "pages"

Window {
    id: root
    visible: true
    width: 200
    height: 200

    flags: Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint
    color: "transparent"

    property bool settingsVisible: false

    AsciiPet {
        id: pet
        anchors.centerIn: parent
        onPositionChanged: function(dx, dy) {
            root.x += dx
            root.y += dy
        }
        onHitAreaTriggered: function(areaName, actionType, actionValue) {
            console.log("Hit area:", areaName, "Action:", actionType, actionValue)
        }
        onShellCommandRequested: function(command) {
            executeShellCommand(command)
        }
    }

    SettingsPage {
        id: settingsPage
        visible: root.settingsVisible
        anchors.centerIn: parent
        onCloseRequested: root.settingsVisible = false
        onAnimationSpeedChanged: function(speed) {
            if (petConfig) {
                petConfig.animationSpeed = speed
            }
        }
        onColorChanged: function(color) {
            if (petConfig) {
                petConfig.characterColor = color
            }
        }
    }

    TrayIcon {
        id: trayIcon
        onShowSettings: root.settingsVisible = true
        onQuitRequested: Qt.quit()
        onShowPet: {
            root.visible = true
            root.settingsVisible = false
        }
        onHidePet: root.visible = false
        onReloadConfig: {
            if (petConfig) {
                petConfig.reloadConfig()
            }
        }
    }

    MouseArea {
        id: dragArea
        anchors.fill: parent
        acceptedButtons: Qt.RightButton
        propagateComposedEvents: true

        onPressed: function(mouse) {
            if (mouse.button === Qt.RightButton) {
                trayIcon.showContextMenu()
                mouse.accepted = true
            } else {
                mouse.accepted = false
            }
        }
    }

    function executeShellCommand(command) {
        console.log("Executing shell command:", command)
    }
}