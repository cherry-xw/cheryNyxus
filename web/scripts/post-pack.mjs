#!/usr/bin/env node
/**
 * electron-builder afterPack 钩子
 *
 * electron-builder 在生成 `win-unpacked/` / `mac/` / `linux-unpacked/` 之后、
 * 打包安装包（NSIS/DMG/AppImage）之前调用本脚本。
 *
 * 目的：把 resources/ 下的用户配置模板复制到 CheryNyxus.exe 同级，让用户在安装包里
 * 直接看到 .env 和 .chery/，**无需等待首次启动**。
 *
 * 复制规则：
 *   resources/.env.example     → <appOutDir>/.env
 *   resources/.chery.template/ → <appOutDir>/.chery/
 *
 * NSIS 安装时默认会覆盖已存在的目标文件。如果用户想"升级不覆盖用户修改"，
 * 需额外加 nsis.include 自定义 .nsh 脚本（暂未实现）。
 *
 * context 文档：https://www.electron.build/configuration/configuration#afterpack
 */
import { existsSync, copyFileSync, cpSync } from "node:fs";
import { join } from "node:path";

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;
  console.log(`[post-pack] platform=${electronPlatformName} appOutDir=${appOutDir}`);

  const resourcesDir = join(appOutDir, "resources");

  // 1. .env.example → .env
  const envExample = join(resourcesDir, ".env.example");
  const envTarget = join(appOutDir, ".env");
  if (existsSync(envExample)) {
    copyFileSync(envExample, envTarget);
    console.log(`[post-pack] ✓ ${envTarget}`);
  } else {
    console.warn(`[post-pack] ⚠ ${envExample} not found, skip .env`);
  }

  // 2. .chery.template/ → .chery/
  const cheryTemplate = join(resourcesDir, ".chery.template");
  const cheryTarget = join(appOutDir, ".chery");
  if (existsSync(cheryTemplate)) {
    cpSync(cheryTemplate, cheryTarget, { recursive: true });
    console.log(`[post-pack] ✓ ${cheryTarget}/`);
  } else {
    console.warn(`[post-pack] ⚠ ${cheryTemplate} not found, skip .chery`);
  }
}