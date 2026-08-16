# store/patterns — 本地经验库

此目录存放 markdown 经验条目（`mem_*.md`），由插件的 `ov-remember` 命令写入。
格式：`【坑】现象 /【根因】一句话 /【对策】可执行 /【关键路径】位置 /【日期】`

默认后端即此目录；配置了 `OPENVIKING_URL` 后自动切换到 OpenViking 向量检索。
