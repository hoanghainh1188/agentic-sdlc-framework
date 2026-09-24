# Review bộ tài liệu thiết kế (D-01 → D-09, CLAUDE.md, bảng mã)

| Mục | Nội dung |
|---|---|
| Ngày | 24/09/2026 |
| Người review | Claude |
| Phạm vi | design/D-01, D-02, D-03, D-05, D-07, D-08, D-09, CLAUDE.md, handbook/00-mo-dau/05-bang-ma.md, README |
| Cách làm | Đọc chéo, dò tự động mã cũ và tham chiếu, kiểm tra lại giấy phép các thành phần chưa rà |

Mức độ: 🔴 Nghiêm trọng (phải xử lý trước khi code) · 🟠 Mâu thuẫn / thiếu (sửa trước khi giao task liên quan) · 🟢 Nhỏ

---

## 1. Nghiêm trọng 🔴

### R1. MinIO đã ngừng bảo trì

- [Bên ngoài] Repo `minio/minio` đã chuyển sang chỉ đọc (archived) ngày 25/04/2026, ghi rõ "không còn được bảo trì" và giới thiệu bản thương mại AIStor.
- [Bên ngoài] Kể cả trước đó, MinIO dùng AGPLv3. Khi đóng gói lại hoặc bán lại, người dùng tự chịu rủi ro.
- Ảnh hưởng: D-02, D-03, D-05, D-07, D-08 đều dùng MinIO. Langfuse tự host cũng cần một kho lưu trữ tương thích S3.
- **Đề xuất: thay bằng SeaweedFS.**
  - [Bên ngoài] SeaweedFS dùng Apache 2.0, chạy được với 1 node. RustFS cũng Apache 2.0 nhưng còn giai đoạn alpha, chưa nên dùng production. Garage dùng AGPLv3.
  - Code platform đã đi qua interface `EvidenceStore` và API S3, nên việc đổi chỉ ảnh hưởng cấu hình và tài liệu.

### R2. Redis đổi giấy phép

- [Bên ngoài] Từ Redis 7.4, giấy phép chuyển sang RSALv2 + SSPLv1. Linux Foundation fork thành **Valkey** (BSD). Redis 8 thêm AGPLv3 làm lựa chọn thứ ba.
- Ảnh hưởng: LiteLLM và Langfuse cần Redis. Ta định bán platform.
- **Đề xuất: dùng Valkey.** Valkey tương thích giao thức với Redis, client cũ dùng được nguyên. Langfuse cũng ghi hỗ trợ Redis/Valkey.

### R3. Máy chủ nội bộ nhận webhook GitHub như thế nào?

- D-03 thiết kế duyệt gate qua comment GitHub. Cơ chế này cần **GitHub gửi webhook vào máy chủ**.
- Máy nội bộ thường **không nhận được kết nối từ internet**. Chưa tài liệu nào xử lý chuyện này.
- Ba cách:

| Cách | Ưu | Nhược |
|---|---|---|
| A. Reverse proxy có IP / domain công khai, chỉ mở đường `/webhooks/github`, giới hạn theo dải IP của GitHub | Đơn giản, thời gian thực | Phải mở 1 cổng ra internet |
| B. Đường hầm ra ngoài (tunnel) do máy nội bộ chủ động mở | Không mở cổng vào | Phụ thuộc dịch vụ tunnel bên thứ ba → trái "tự host" |
| C. **Không dùng webhook**: platform định kỳ hỏi GitHub API (polling) | Không cần mở gì. Hợp máy nội bộ | Chậm hơn (chờ vài chục giây – 1 phút). Tốn lượt gọi API |

- **Đề xuất:** MVP làm **C (polling)** sau interface, để chạy được ngay trên máy nội bộ. Giữ khả năng bật **A** khi có hạ tầng. Chờ anh chốt.

### R4. "Người chạy agent" chưa được định nghĩa (FR-11, G7)

- FR-11 ghi: "người chạy agent không duyệt được G7". Nhưng agent do **workflow** khởi chạy sau G4, không phải do một người bấm nút.
- D-05 có cột `runs.started_by` nhưng không nói ai được ghi vào đó.
- D-02 bảng gate lại ghi G7: "Người tạo intent không tự approve". Hai chỗ **không khớp nhau**.
- Ba cách hiểu:

| Cách | Luật G7 | Nhận xét |
|---|---|---|
| A | Người duyệt G7 ≠ **người tạo intent** | Đơn giản. Người yêu cầu không tự nghiệm thu |
| B | Người duyệt G7 ≠ **người duyệt G3** (người đã duyệt plan cho agent chạy) | Tách "cho phép làm" và "chấp nhận kết quả". Công ty nhỏ có thể khó đủ người |
| C | Cả A và B | Chặt nhất |

- **Đề xuất: A cho MVP**, cấu hình được để bật C sau. Chờ anh chốt.

---

## 2. Mâu thuẫn và thiếu sót 🟠

| # | Vấn đề | Ở đâu | Đề xuất sửa |
|---|---|---|---|
| M1 | Thời điểm làm repo mẫu: D-09 ghi "song song với M-A"; D-02 v0.3 ghi "ngay trước M-C" | D-09 mục 9 | Sửa D-09 theo D-02 |
| M2 | Tiêu chí hoàn thành MVP số 1 đòi thêm "1 intent trên tool nội bộ thật (C)", nhưng C thuộc M-F. D-08 task D07 chỉ yêu cầu repo mẫu | D-02 mục 10 | Tách: tiêu chí MVP chỉ cần repo mẫu; tool thật chuyển sang tiêu chí của M-F |
| M3 | Stack ghi "NestJS hoặc Fastify", trong khi D-03 đã chọn NestJS | D-02 mục 8 | Sửa thành NestJS |
| M4 | Mức tự chủ 1 (task High, ví dụ T09): agent chỉ nộp đề xuất. Nhưng không có chỗ lưu "đề xuất" | D-05 | Thêm `kind = proposal` cho `evidence_items`; thêm trạng thái run `succeeded_proposal_only` |
| M5 | Agent đề xuất plan (`plans.proposed_by_type`) và ghi audit, nhưng enum chỉ có `human`, `system` | D-05 mục 5 | Thêm `agent` vào enum người thực hiện |
| M6 | D-03 mục 5.2 (bảng module Tenancy/Auth) chưa có `api_tokens` | D-03 | Bổ sung |
| M7 | Bảng thành phần tự xây ở D-01 mục 6 đánh số lộn xộn (7b, 7c, 11 nằm trước 10) | D-01 | Đánh số lại 1–13 |
| M8 | README gốc vẫn ghi "Phiên bản 0.1 (khung repo)", bảng người đọc chỉ nói về handbook | README.md | Cập nhật theo monorepo |
| M9 | D-07 định tuyến theo 4 nhóm dữ liệu; D-05 có 5 giá trị `data_class` | D-07 mục 4 | Dùng đúng 5 tên của D-05 |
| M10 | G5 kích hoạt khi "agent xong / đạt mốc", nhưng chưa định nghĩa "mốc" | D-03 mục 6 | MVP: kiểm tra G5 **khi agent kết thúc** và **mỗi lần đồng bộ chi phí** (không cần "mốc") |
| M11 | Chưa có yêu cầu nhắc hạn qua kênh ngoài GitHub (email, chat) | D-02 FR-12 | Ghi rõ MVP chỉ nhắc qua comment. Kênh khác để MVP+1 |

---

## 3. Nhỏ 🟢

| # | Vấn đề | Đề xuất |
|---|---|---|
| N1 | D-08 dùng mã task `D01…D07` trùng hình thức với mã tài liệu `D-01…D-09` | Đổi tiền tố task M-D thành `E` (ví dụ `E01`) để khỏi nhầm |
| N2 | Nhiều tài liệu ghi "Chờ Harry duyệt" nhưng chưa có nơi ghi trạng thái duyệt | Thêm cột "Ngày duyệt" vào `design/README.md` |
| N3 | Sơ đồ D1 (6 giai đoạn) chưa thể hiện gate G4–G6 là tự động trong platform | Không cần sửa. Màu xanh đã thể hiện |

---

## 4. Điểm tốt (giữ nguyên)

- Bộ mã (P1–P6, Mức 0–3, G1–G8) dùng **nhất quán**. Không còn mã cũ ngoài các bảng đối chiếu.
- Yêu cầu có mã và tiêu chí nghiệm thu, nối được từ D-02 → D-08 → test.
- Các rủi ro giấy phép đã rà (Vault → OpenBao, LiteLLM, Langfuse Enterprise, BMAD thương hiệu).
- Thiết kế gate, ngân sách, luật đều là **cấu hình** → sẵn sàng cho vòng tinh chỉnh M-F.

---

## 5. Việc cần làm

| Việc | Ai |
|---|---|
| Chốt R1–R4 | Harry — **Đã chốt 24/09/2026**: R1 SeaweedFS, R2 Valkey, R3 polling (webhook sau), R4 phương án A |
| Sửa M1–M11, N1–N2 | Claude — **Đã sửa** (CHANGELOG 0.13) |
| Chuyển các tài liệu sang trạng thái "Đã duyệt" | Harry, sau khi sửa |

---

## Nguồn tham khảo (bên ngoài, truy cập 24/09/2026)

- MinIO GitHub (archived): https://github.com/minio/minio
- So sánh RustFS / SeaweedFS / Garage (Elestio): https://blog.elest.io/rustfs-vs-seaweedfs-vs-garage-which-minio-alternative-should-you-pick/
- Redis 8.0 thêm AGPLv3 (Phoronix): https://www.phoronix.com/news/Redis-8.0-Goes-AGPLv3
- Valkey vs Redis (computingforgeeks): https://computingforgeeks.com/valkey-vs-redis-migration/
- Langfuse self-hosting: https://langfuse.com/self-hosting
