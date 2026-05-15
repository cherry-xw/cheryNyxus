#pragma once

#include <QObject>
#include <QString>
#include <QStringList>
#include <QVariantMap>
#include <QFileSystemWatcher>
#include <yaml-cpp/yaml.h>

struct FrameData {
    QString name;
    QStringList lines;
    QVariantMap hitAreas;
};

struct HitArea {
    QString name;
    int x, y, width, height;
    QString actionType;
    QString actionValue;
};

class PetConfig : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString configPath READ configPath WRITE setConfigPath NOTIFY configChanged)
    Q_PROPERTY(QStringList frames READ frames NOTIFY configChanged)
    Q_PROPERTY(QString defaultFrame READ defaultFrame NOTIFY configChanged)
    Q_PROPERTY(int animationSpeed READ animationSpeed NOTIFY configChanged)
    Q_PROPERTY(QString characterColor READ characterColor NOTIFY configChanged)
    Q_PROPERTY(QVariantMap hitAreas READ hitAreas NOTIFY configChanged)

public:
    explicit PetConfig(QObject *parent = nullptr);

    QString configPath() const;
    void setConfigPath(const QString &path);

    QStringList frames() const;
    QString defaultFrame() const;
    int animationSpeed() const;
    QString characterColor() const;
    QVariantMap hitAreas() const;

    Q_INVOKABLE QStringList getFrameLines(const QString &frameName);
    Q_INVOKABLE QVariantMap getHitAreaAt(int x, int y, const QString &frameName);

    void loadConfig();
    void reloadConfig();

signals:
    void configChanged();
    void hitAreaTriggered(const QString &areaName, const QString &actionType, const QString &actionValue);

private:
    QString m_configPath;
    std::map<QString, FrameData> m_frames;
    QString m_defaultFrame;
    int m_animationSpeed;
    QString m_characterColor;
    QVariantMap m_hitAreas;
    QFileSystemWatcher *m_watcher;

    void parseConfig(const YAML::Node &config);
    FrameData parseFrame(const YAML::Node &frameNode);
    HitArea parseHitArea(const YAML::Node &areaNode);
};