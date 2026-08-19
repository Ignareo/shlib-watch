# 安卓 App（shlib-watch mobile）

把「图书难借吗」打包成安卓 APK：**抓取直接在手机上执行，数据只存在手机本地**，与网页端 / GitHub 互不影响。App 内嵌与网页端同一套看板 UI 与采样器代码（Capacitor 壳 + sampler 同构核心），后续改解析规则或看板样式，网页端和 App 同时生效。

## 构建

```bash
cd mobile
npm install
npm run build        # 拷贝 docs/ → www/，esbuild 打包 sampler 核心，cap sync 同步到安卓工程
npm run open         # 打开 Android Studio，Run 到真机/模拟器
# 或命令行出包（需本机 Android SDK + JDK 17）：
cd android && ./gradlew assembleDebug
# 产物：mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

- **依赖环境**：Android Studio（含 Android SDK）+ JDK 17，仅构建时需要
- `www/` 为构建产物，已 gitignore，不要手动改

## 使用

- **采样**：打开 App 时若今天还没采样会自动补采一次（遵循 `config.json` 的周期设置）；书单助手里的「重新采样」按钮可强制立即采样，日志实时显示
- **数据**：存储在 App 私有目录（Capacitor Filesystem）；首次启动使用 APK 内置的种子数据，本机采样后自动覆盖；卸载 App 数据即清除
- **书单**：书单助手里的「下载 books.txt」在 App 内变为「保存到本机」，保存后下次采样生效，无需提交仓库
- **验证码**：若触发上图人机验证，App 会跳转到验证页，手动完成滑块后按系统返回键回到 App，再点一次「重新采样」即可

## 实现要点

- `sampler-entry.js` 是 App 端 platform 实现：CapacitorHttp 绕 CORS、Filesystem 存储、WebView 内过码，暴露 `window.BbtApp`
- 看板通过检测 `window.Capacitor` + `window.BbtApp` 进入 App 模式：`fetchJson("data/*")` 分流到本机 Filesystem（读不到时回退 APK 内置种子），隐藏 GitHub Actions 区

## 待真机实测点

1. CapacitorHttp 的重定向 URL（`response.url`）与 form POST 行为
2. 验证码 WebView 跳转后 cookie 是否被原生层共享
3. 手机网络 IP 触发风控的频率可能高于家庭宽带（可调大 `config.json` 的 `request.intervalMs`）
