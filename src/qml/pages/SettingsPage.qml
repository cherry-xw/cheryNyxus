import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: root
    width: 300
    height: 200
    color: "#2a2a2a"
    radius: 10
    border.color: "#444444"
    border.width: 1

    signal closeRequested()
    signal animationSpeedChanged(int speed)
    signal colorChanged(string color)

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 20
        spacing: 15

        RowLayout {
            Layout.fillWidth: true

            Text {
                text: qsTr("设置")
                font.pixelSize: 18
                font.bold: true
                color: "#ffffff"
            }

            Item { Layout.fillWidth: true }

            Button {
                text: "×"
                flat: true
                onClicked: root.closeRequested()
                contentItem: Text {
                    text: parent.text
                    color: "#ffffff"
                    font.pixelSize: 16
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true

            Text {
                text: qsTr("动画速度")
                color: "#cccccc"
                font.pixelSize: 14
            }

            Slider {
                id: speedSlider
                Layout.fillWidth: true
                from: 100
                to: 1000
                value: 500
                onValueChanged: {
                    speedLabel.text = value + "ms"
                }
            }

            Text {
                id: speedLabel
                text: "500ms"
                color: "#cccccc"
                font.pixelSize: 12
            }
        }

        RowLayout {
            Layout.fillWidth: true

            Text {
                text: qsTr("字符颜色")
                color: "#cccccc"
                font.pixelSize: 14
            }

            ComboBox {
                id: colorCombo
                Layout.fillWidth: true
                model: ["白色", "绿色", "蓝色", "红色", "黄色"]
            }
        }

        Button {
            Layout.fillWidth: true
            text: qsTr("保存设置")
            onClicked: {
                root.animationSpeedChanged(speedSlider.value)
                var colors = ["#ffffff", "#00ff00", "#0088ff", "#ff0000", "#ffff00"]
                root.colorChanged(colors[colorCombo.currentIndex])
                root.closeRequested()
            }
        }
    }

    MouseArea {
        anchors.fill: parent
        onPressed: function(mouse) {
            mouse.accepted = false
        }
    }
}