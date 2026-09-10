# 图源说明

`build.mjs` 是本版 7 张图和 HTML 阅读稿的生成源文件；不启动、连接或修改应用服务。

- 修改图：编辑对应编号的内容，或直接使用 `图片和附件/*.svg`。
- 修改文档：编辑上一级 `review-design.md`、`implementation-design.md`。
- 重新生成：在此目录运行 `node build.mjs /你的路径/cws-fe/apps/web/package.json`。
- 本地依赖复用前端已安装的 React、react-dom、react-markdown、remark-gfm 和 Next 所依赖的 sharp。不需要访问网络。
- 中文字体使用 PingFang SC；其他系统需安装兼容中文字体以避免乱码。

HTML、PNG 是导出件，更新原文后需重新生成。HTML 图片为相对路径，分享时请连同“图片和附件”目录一起发送；SVG 可独立打开。

图是目标设计，不是现有系统已实现的声明。箭头表示应用消息方向；两侧的 WSS 都由插件／Channel 主动向 cws-comm 建连。
