#include "PetConfig.h"
#include <QFile>
#include <QDebug>

PetConfig::PetConfig(QObject *parent)
    : QObject(parent)
    , m_configPath("pet.yaml")
    , m_animationSpeed(500)
    , m_characterColor("#ffffff")
    , m_watcher(new QFileSystemWatcher(this))
{
    loadConfig();

    connect(m_watcher, &QFileSystemWatcher::fileChanged, this, [this](const QString &path) {
        if (path == m_configPath) {
            reloadConfig();
        }
    });
}

QString PetConfig::configPath() const {
    return m_configPath;
}

void PetConfig::setConfigPath(const QString &path) {
    if (m_configPath != path) {
        if (m_watcher->files().contains(m_configPath)) {
            m_watcher->removePath(m_configPath);
        }
        m_configPath = path;
        m_watcher->addPath(m_configPath);
        loadConfig();
    }
}

QStringList PetConfig::frames() const {
    QStringList result;
    for (const auto &pair : m_frames) {
        result.append(pair.first);
    }
    return result;
}

QString PetConfig::defaultFrame() const {
    return m_defaultFrame;
}

int PetConfig::animationSpeed() const {
    return m_animationSpeed;
}

QString PetConfig::characterColor() const {
    return m_characterColor;
}

QVariantMap PetConfig::hitAreas() const {
    return m_hitAreas;
}

QStringList PetConfig::getFrameLines(const QString &frameName) {
    auto it = m_frames.find(frameName);
    if (it != m_frames.end()) {
        return it->second.lines;
    }
    return QStringList();
}

QVariantMap PetConfig::getHitAreaAt(int x, int y, const QString &frameName) {
    auto frameIt = m_frames.find(frameName);
    if (frameIt == m_frames.end()) {
        return QVariantMap();
    }

    QVariantMap result;
    for (const auto &pair : frameIt->second.hitAreas.toMap()) {
        QVariantMap area = pair.value.toMap();
        int ax = area["x"].toInt();
        int ay = area["y"].toInt();
        int aw = area["width"].toInt();
        int ah = area["height"].toInt();

        if (x >= ax && x <= ax + aw && y >= ay && y <= ay + ah) {
            result["name"] = pair.key;
            result["actionType"] = area["actionType"];
            result["actionValue"] = area["actionValue"];
            return result;
        }
    }
    return QVariantMap();
}

void PetConfig::loadConfig() {
    QFile file(m_configPath);
    if (!file.exists()) {
        qWarning() << "Config file not found:" << m_configPath;
        return;
    }

    try {
        YAML::Node config = YAML::LoadFile(m_configPath.toStdString());
        parseConfig(config);
        emit configChanged();
    } catch (const YAML::Exception &e) {
        qWarning() << "YAML parse error:" << e.what();
    }

    if (!m_watcher->files().contains(m_configPath)) {
        m_watcher->addPath(m_configPath);
    }
}

void PetConfig::reloadConfig() {
    loadConfig();
}

void PetConfig::parseConfig(const YAML::Node &config) {
    m_frames.clear();
    m_hitAreas.clear();

    if (config["animation_speed"]) {
        m_animationSpeed = config["animation_speed"].as<int>();
    }

    if (config["character_color"]) {
        m_characterColor = QString::fromStdString(config["character_color"].as<std::string>());
    }

    if (config["default_frame"]) {
        m_defaultFrame = QString::fromStdString(config["default_frame"].as<std::string>());
    }

    if (config["frames"]) {
        for (const auto &frameNode : config["frames"]) {
            FrameData frame = parseFrame(frameNode);
            m_frames[frame.name] = frame;
        }
    }
}

FrameData PetConfig::parseFrame(const YAML::Node &frameNode) {
    FrameData frame;

    if (frameNode["name"]) {
        frame.name = QString::fromStdString(frameNode["name"].as<std::string>());
    }

    if (frameNode["lines"]) {
        for (const auto &line : frameNode["lines"]) {
            frame.lines.append(QString::fromStdString(line.as<std::string>()));
        }
    }

    if (frameNode["hit_areas"]) {
        QVariantMap areas;
        for (const auto &areaNode : frameNode["hit_areas"]) {
            HitArea area = parseHitArea(areaNode);
            QVariantMap areaMap;
            areaMap["x"] = area.x;
            areaMap["y"] = area.y;
            areaMap["width"] = area.width;
            areaMap["height"] = area.height;
            areaMap["actionType"] = area.actionType;
            areaMap["actionValue"] = area.actionValue;
            areas[area.name] = areaMap;
        }
        frame.hitAreas = areas;
    }

    return frame;
}

HitArea PetConfig::parseHitArea(const YAML::Node &areaNode) {
    HitArea area;

    if (areaNode["name"]) {
        area.name = QString::fromStdString(areaNode["name"].as<std::string>());
    }
    if (areaNode["x"]) {
        area.x = areaNode["x"].as<int>();
    }
    if (areaNode["y"]) {
        area.y = areaNode["y"].as<int>();
    }
    if (areaNode["width"]) {
        area.width = areaNode["width"].as<int>();
    }
    if (areaNode["height"]) {
        area.height = areaNode["height"].as<int>();
    }
    if (areaNode["action_type"]) {
        area.actionType = QString::fromStdString(areaNode["action_type"].as<std::string>());
    }
    if (areaNode["action_value"]) {
        area.actionValue = QString::fromStdString(areaNode["action_value"].as<std::string>());
    }

    return area;
}