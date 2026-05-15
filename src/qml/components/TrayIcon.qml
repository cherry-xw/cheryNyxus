import QtQuick
import Qt.labs.platform as Platform

Item {
    id: root

    signal showSettings()
    signal quitRequested()
    signal showPet()
    signal hidePet()
    signal reloadConfig()

    function showContextMenu() {
        menu.open()
    }

    Platform.SystemTrayIcon {
        id: trayIcon
        visible: true
        icon.name: "applications-other"

        menu: Platform.Menu {
            id: menu

            Platform.MenuItem {
                text: qsTr("显示桌宠")
                onTriggered: root.showPet()
            }

            Platform.MenuItem {
                text: qsTr("隐藏桌宠")
                onTriggered: root.hidePet()
            }

            Platform.MenuSeparator {}

            Platform.MenuItem {
                text: qsTr("重载配置")
                onTriggered: root.reloadConfig()
            }

            Platform.MenuSeparator {}

            Platform.MenuItem {
                text: qsTr("设置")
                onTriggered: root.showSettings()
            }

            Platform.MenuSeparator {}

            Platform.MenuItem {
                text: qsTr("退出")
                onTriggered: root.quitRequested()
            }
        }

        onActivated: function(reason) {
            if (reason === Platform.SystemTrayIcon.DoubleClick) {
                root.showPet()
            }
        }
    }
}