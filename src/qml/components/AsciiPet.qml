import QtQuick

Item {
    id: root
    width: 150
    height: 150

    signal positionChanged(int dx, int dy)
    signal hitAreaTriggered(string areaName, string actionType, string actionValue)
    signal shellCommandRequested(string command)

    property string currentFrame: petConfig ? petConfig.defaultFrame : "idle"
    property int animationSpeed: petConfig ? petConfig.animationSpeed : 500
    property string characterColor: petConfig ? petConfig.characterColor : "#ffffff"

    property var idleFrames: ["idle", "idle2"]
    property int currentIdleIndex: 0

    Rectangle {
        anchors.fill: parent
        color: "transparent"

        Text {
            id: asciiText
            anchors.centerIn: parent
            font.family: "monospace"
            font.pixelSize: 12
            color: root.characterColor
            text: petConfig ? petConfig.getFrameLines(root.currentFrame).join("\n") : ""
            style: Text.Outline
            styleColor: "#333333"

            Behavior on text {
                enabled: true
                SmoothedAnimation { duration: 100 }
            }

            Behavior on color {
                enabled: true
                ColorAnimation { duration: 200 }
            }
        }
    }

    MouseArea {
        id: clickArea
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton

        onClicked: function(mouse) {
            handleHitArea(mouse.x, mouse.y)
        }

        onPressed: function(mouse) {
            root.lastMousePos = Qt.point(mouse.x, mouse.y)
        }

        property point lastMousePos

        onPositionChanged: function(mouse) {
            if (pressed) {
                var dx = mouse.x - lastMousePos.x
                var dy = mouse.y - lastMousePos.y
                root.positionChanged(dx, dy)
                lastMousePos = Qt.point(mouse.x, mouse.y)
            }
        }
    }

    Timer {
        id: idleAnimation
        interval: root.animationSpeed
        repeat: true
        running: isIdleFrame(root.currentFrame)
        onTriggered: {
            if (isIdleFrame(root.currentFrame)) {
                currentIdleIndex = (currentIdleIndex + 1) % idleFrames.length
                root.currentFrame = idleFrames[currentIdleIndex]
            }
        }

        function isIdleFrame(frame) {
            return idleFrames.indexOf(frame) >= 0 || frame === "sleep"
        }
    }

    Connections {
        target: petConfig
        function onConfigChanged() {
            root.animationSpeed = petConfig.animationSpeed
            root.characterColor = petConfig.characterColor
            idleAnimation.interval = root.animationSpeed
            if (idleFrames.indexOf(root.currentFrame) < 0) {
                root.currentFrame = petConfig.defaultFrame
            }
        }
    }

    function handleHitArea(x, y) {
        if (!petConfig) return

        var hitArea = petConfig.getHitAreaAt(x, y, root.currentFrame)
        if (hitArea.name) {
            executeAction(hitArea.actionType, hitArea.actionValue, hitArea.name)
        }
    }

    function executeAction(actionType, actionValue, areaName) {
        root.hitAreaTriggered(areaName, actionType, actionValue)

        switch (actionType) {
            case "builtin":
                setAnimation(actionValue)
                break
            case "signal":
                if (actionValue === "moveLeft") {
                    moveLeft()
                } else if (actionValue === "moveRight") {
                    moveRight()
                }
                break
            case "shell":
                root.shellCommandRequested(actionValue)
                break
        }
    }

    function setAnimation(name) {
        if (petConfig && petConfig.frames().indexOf(name) >= 0) {
            root.currentFrame = name
            idleAnimation.running = (name === "idle" || name === "idle2" || name === "sleep")
        }
    }

    function moveLeft() {
        setAnimation("walk_left")
        positionChanged(-10, 0)
    }

    function moveRight() {
        setAnimation("walk_right")
        positionChanged(10, 0)
    }

    function happy() {
        setAnimation("happy")
    }

    function sleep() {
        setAnimation("sleep")
    }

    function idle() {
        setAnimation("idle")
    }

    function forceUpdate() {
        if (petConfig) {
            petConfig.reloadConfig()
        }
    }
}