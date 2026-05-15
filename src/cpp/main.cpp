#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QSystemTrayIcon>
#include <QMenu>
#include <QIcon>
#include <QFile>
#include "PetConfig.h"

int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);
    app.setApplicationName("cheryClaw");
    app.setApplicationVersion("1.0.0");

    PetConfig petConfig;

    QString configPath = "pet.yaml";
    if (QFile::exists(configPath)) {
        petConfig.setConfigPath(configPath);
    }

    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("petConfig", &petConfig);

    const QUrl url(u"qrc:/cheryClaw/src/qml/main.qml"_qs);

    QObject::connect(
        &engine, &QQmlApplicationEngine::objectCreated,
        &app, [url](QObject *obj, const QUrl &objUrl) {
            if (!obj && url == objUrl)
                QCoreApplication::exit(-1);
        },
        Qt::QueuedConnection);

    engine.load(url);

    return app.exec();
}