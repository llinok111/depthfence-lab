# depthfence-lab

**一句话承诺**：标准深度缓冲在 **1 km 处只有 0.5957 m 的深度分辨率**（对照基线：reversed-Z 为 **7.2757e-5 m**，相差 **8187×**）；本工具用一次解析推导给出这个数字（**1.99 µs/次**，基线「渲染一帧再数冲突像素」为 **753.97 µs/帧**，**379.6×**），并在 **552,960 个深度样本 / 18 张图** 上与一个独立的 4×4 矩阵 oracle 逐样本一致（**0 不一致**），最后给出最便宜的修法与裕度。

Upstream: none

这是一个**原创**工具：它不修任何上游仓库，只把 three.js / WebGL 的深度精度问题做成可复算的证书。

## 它解决什么

大场景（GIS、飞行模拟、CAD）里「远处两个面开始闪」通常靠肉眼看。肉眼看不出：

- 在哪个距离开始闪（本例：2 cm 视深差在 `near=0.1, far=3000` 下从 **183.2 m** 起失效）；
- 提高 near 够不够（本例：需要 near ≥ 27 m，但相机高 1.7 m，**做不到**）；
- 换 reversed-Z 能好多少（**8187×**，裕度 231×）。

`src/core.mjs` 把答案变成距离的函数：`depthBinWidth(z, mode, near, far)` 是 **z 处一个 float32 深度 bin 的宽度（米）**。两个面在视深上相差小于这个宽度，就可能写进同一个深度值 —— 这就是 z-fight。

## 怎么跑（一条命令）

```bash
node tools/gen-sample.mjs && node bench/verify.mjs && node bench/bench.mjs
```

页面（可选，纯静态）：

```bash
python3 -m http.server 4173   # 然后打开 http://localhost:4173
```

页面用 CDN importmap 固定 `three@0.169.0`，不需要 `npm install`。所有判定数字都由 `src/core.mjs` 现算，与 node 里跑的是同一份代码。

## 证据（全部来自 `bench/result.json`，可复跑）

| 项目 | 数字 | 复跑命令 |
|---|---|---|
| 1 km 处 standard 分辨率 | **0.5957 m** | `node bench/bench.mjs` |
| 1 km 处 reversed-Z | **7.2757e-5 m**（**8187×**） | 同上 |
| 1 km 处 log depth | **4.7771e-4 m**（**1247×**） | 同上 |
| 解析证书成本 | **1.986 µs/query**（2000 query 中位 3.973 ms，relStddev 3.2%） | 同上 |
| 基线：逐像素渲染数冲突 | **753.97 µs/帧**（40 帧中位 30.159 ms，relStddev 27.7%） | 同上 |
| 每答案加速 | **379.6×** | 同上 |
| 独立 oracle 一致性 | **552,960 样本 / 18 图 / 0 不一致**（其中 49,920 个样本真的 tie） | `node bench/verify.mjs` |
| 断言 | **44 passed / 0 failed** | `node bench/verify.mjs` |
| 2 cm 失效起点 | **183.2 m** | 同上（A11） |
| 高速场景修法 | **reversed-Z**，裕度 **231.0×**（网格最坏 **8.6577e-5 m**，复检最坏 **7.2757e-5 m**） | 同上（A9） |
| CAD 场景修法 | **raise-near 0.01 → 0.4431 m**（≤ 0.5 m 相机净空），复检最坏 **1.4815e-4 m** | 同上（A9） |
| 掠射对照（地面 2 cm 涂层） | 19,968 px **0 tie**，最小视深差 **0.03 m**，同处 bin 宽 **0.05 m** | 同上（A10） |

**为什么「1 km 处 0.6 m」不是拍脑袋**：`d = f/(f-n)(1-n/z)`，`dd/dz = n/z² = 1e-7 /m`（n=0.1, z=1000），而 1 km 处 `d≈0.99993` 的 float32 ULP 是 `5.96e-8`，于是 `5.96e-8 / 1e-7 = 0.596 m`。代码里 `depthBinWidth` 用二分直接量出**包含 z 的那个量化 bin 的上下边界之和**，`depthStepAnalytic` 用一阶导数独立复算，两者 1 km 处相差 **< 0.01%**。

## 本轮创新

**B 档**：把「深度缓冲会不会 z-fight」从渲染后肉眼判断，变成**距离函数上的量化 bin 宽度证书** —— 解析给出 1 ULP 边界（无 epsilon），用**独立 4×4 矩阵 oracle**（lookAt + 透视矩阵 + unproject，与主实现的闭式有理式不共享任何公式/常量）逐样本复算 552,960 个样本 0 不一致，并在给出修法后按同一函数**复检**最坏距离的 bin 宽度与裕度。和已有的 `mesh-defect-doctor` / `convexity-cert-lab` / `toi-cert-lab` 不同：那些是几何拓扑与三角对判定，这里判定的是**投影后的数值精度**，输入是 `(near, far, mode, z)` 而不是网格。台账无深度精度/z-fight 先例。

## 已知限制（必须读）

1. **只建模 float32 深度存储**。WebGL 默认深度是 24-bit UNORM，其分辨率 `z²/(n·2^24)` 在数值上等于本模型在 `d≈1`（远端）处的值，因此本文的 standard 数字可当作 24-bit 的远端上界；但 24-bit 在近处**不会**像 float32 那样变精细，本工具不声称覆盖这一点。页面表格标注了「模型 = float32」。
2. **没有绝对阈值/epsilon**：唯一的绝对量是用户给的 `separation`（本例 0.02 m 涂层）与 `near/far`。尺度不变性因此在 1e-6…1e6 十二个数量级上**逐位**成立（`verify` A5：归一化 bin 宽度相对误差 < 1e-9），而不是「近似不变」。
3. **测试图是前向平行的贴片对**（每块 16×16 px，深度在块内恒定），因为它隔离的正是「视深差 δ vs bin 宽度」这一维。掠射角被**故意排除**：沿掠射光线两个水平面在视深上相差 `δ/|dy|` 而不是 δ（A10 实测最小 0.03 m、bin 宽 0.05 m，0 tie），所以「地面涂层在远处一定会闪」是错的；本工具不声称能判定任意三角面之间的 z-fight。
4. **计时波动**：基线逐像素路径 relStddev **27.7%**（40 帧 × 19,968 px，GC/JIT 占主导，绝对区间 30.2 ± 8.4 ms）；证书路径 relStddev 3.2%。两者都报中位 + p95 + 冷启动，不挑最快值。
5. **页面不能真的切 reversed-Z**：three.js/WebGL2 没有 clip-control，页面演示的是「提高 near」这一免费修法，reversed-Z/log 的数字以表格和曲线给出。页面条纹由具体 GPU 深度格式决定，表格数字不依赖 GPU。
6. 未声称：MSAA/多重采样下的解析、depth test 的比较精度、以及 GPU 端实测（本仓库**零浏览器自动化**，无截图，`bench/result.json` 是唯一证据来源）。

## 仓库结构

```
src/core.mjs          纯计算：投影、ULP、bin 宽度、图、修法选择（无 three / 无 DOM）
bench/verify.mjs      44 条断言（端点、往返、ULP、尺度不变性、oracle、修法、掠射对照）
bench/oracle.mjs      独立实现：4×4 矩阵 + unproject，不 import core
bench/bench.mjs       1 次 warmup + 7 次重复，冷启动/中位/p95/stddev
baseline/naive.mjs    基线：渲染数冲突 + 「只看近平面」的朴素判据（反例见 verify A10）
tools/gen-sample.mjs  确定性生成 data/scenes.json（6 个真实尺度场景）
main.js / index.html  只做渲染与交互，所有数字来自 core
```

## 许可证

MIT，见 `LICENSE`。
