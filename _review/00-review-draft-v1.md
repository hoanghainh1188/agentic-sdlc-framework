# Review bản nháp Handbook v1.0 — Bảng Giữ / Sửa / Chuyển / Bỏ / Thêm

| Mục | Nội dung |
|---|---|
| Tài liệu được review | AI-Agentic-SDLC-Handbook.md (v1.0, 22/09/2026, Draft) |
| Khung đích | Phương án C: Phần 0 Mở đầu · Phần I Chính sách · Phần II Playbook 6 giai đoạn · Phần III Template |
| Bộ mã đã chốt | 4 mức tự chủ (Mức 0–3) + 8 gate (G1–G8) |
| Pilot | Bật đủ 8 gate |
| Nơi lưu | Git repo (Markdown + Mermaid, xuất SVG) |
| Trạng thái | Chờ duyệt |

---

## 1. Nhận xét tổng quan

- [Tài liệu] Bản nháp dài khoảng 1,15 triệu ký tự. Gồm 10 chương và 6 phụ lục.
- [Tài liệu] Trọng tâm là **xây một nền tảng** (platform) quản lý agent. Ví dụ: Control Plane, Signed Run Contract, vector DB.
- [Đề xuất] Handbook mới cần trọng tâm khác. Đó là **quy trình và quản trị** cho công ty vừa và nhỏ.
- [Đề xuất] Vì vậy phần lớn Chương 4, 5, 7 không bỏ. Ta **chuyển** sang một tài liệu riêng: "Tài liệu kỹ thuật nền tảng".
- [Đề xuất] Mục tiêu độ dài handbook lõi: khoảng 1/5 bản nháp.
- [Tài liệu] Bản nháp chưa có chương riêng cho **Kiểm thử** và **Triển khai** theo khuôn 9 mục.
- [Tài liệu] Bản nháp giả định stack Supabase. Công ty dùng AWS, cần đổi.

Ký hiệu cột "Quyết định":
- **GIỮ**: giữ gần nguyên, chỉ đổi mã.
- **SỬA**: rút gọn hoặc viết lại.
- **CHUYỂN**: đưa sang tài liệu kỹ thuật nền tảng hoặc phụ lục.
- **BỎ**: không dùng nữa.
- **THÊM**: bản nháp chưa có, cần viết mới.

---

## 2. Đổi mã: bản nháp → bộ mã đã chốt

### 2.1. Mức tự chủ

| Bản nháp | Mã mới | Ghi chú |
|---|---|---|
| L0 Human-only | Mức 0 | Giữ nghĩa |
| L1 Assist | Mức 1 | Giữ nghĩa |
| L2 Sandbox | Mức 2 | Gộp |
| L3 Supervised | Mức 2 | Gộp với L2. Mở PR vẫn thuộc Mức 2 |
| L4 Controlled production | Mức 3 | Giữ nghĩa |

[Tài liệu] Chính bản nháp (mục 3.3.1) đã có bảng đối chiếu này.

### 2.2. Gate

| Bản nháp (G0–G12) | Gate mới | Tên gate mới |
|---|---|---|
| G0 Intake + G1 Intent | G1 | Intent / Scope / Risk |
| G2 Specification | G2 | Specification |
| G3 Architecture/Plan | G3 | Plan / Architecture |
| G4 Agent Admission + G5 Run Authorization | G4 | Execution boundary |
| G6 Pre-Action Tool + G7 Scope Drift + G8 Budget | G5 | Scope-drift |
| G9 Verification (a)–(d) | G6 | Independent verification |
| G10 Human Approval | G7 | Human review / Merge |
| G11 Release + G12 Outcome | G8 | Release / Learning |

[Tài liệu] Ánh xạ lấy từ Hình 6.2-a của bản nháp ("8 sprint gate và mã gate chuẩn tương ứng").

### 2.3. Mã khác

| Mã bản nháp | Quyết định | Lý do |
|---|---|---|
| S0–S9 (10 giai đoạn) | SỬA → 6 giai đoạn | Khớp phạm vi framework |
| P1–P8 (8 plane) | CHUYỂN | Thuộc kiến trúc platform |
| M0–M4 (milestone) | SỬA → Pha 0–3 | Khớp lộ trình pilot |
| Cấp 1–5 (trưởng thành) | GIỮ, rút gọn | Giúp lãnh đạo tự đánh giá |
| CL1–CL5, C1–C10, I1–I8, V1–V10 | CHUYỂN | Thuộc khung năng lực nhân sự |
| W1–W8, PQ1–PQ8, Lv1–Lv5 | CHUYỂN | Thuộc đánh giá platform |
| ADR-01…17 | CHUYỂN | Là quyết định kiến trúc platform |
| ASI01–ASI10 (OWASP) | GIỮ | Dùng ở chương bảo mật |
| Risk tier Low–Critical | GIỮ | Dùng để chọn mức tự chủ |

---

## 3. Bảng quyết định theo từng chương

### Chương 0 — Tóm tắt điều hành

| Mục | Quyết định | Đích đến | Ghi chú |
|---|---|---|---|
| 0.1 Vấn đề | GIỮ | Ch.1 (Phần I) | |
| 0.2 Tám thông điệp | SỬA | Ch.1 | Rút còn 5 thông điệp |
| 0.3 Kiến trúc trong một hình | CHUYỂN | Tài liệu kỹ thuật | Thay bằng sơ đồ D1 (6 giai đoạn + gate) |
| 0.4 Công việc chạy thế nào | SỬA | Ch.8 | Viết lại theo G1–G8 |
| 0.5 Mười quyết định kiến trúc | CHUYỂN | Tài liệu kỹ thuật | |
| 0.6 Stack đề xuất | SỬA | Ch.7 | Đổi Supabase → AWS |
| 0.7 Đánh giá platform | BỎ | — | Không phải việc của lãnh đạo SME |
| 0.8 Vai trò mới | SỬA | Ch.5 | Gộp vào RACI |
| 0.9 Lộ trình M0–M4 | SỬA | Ch.1, Ch.7 | Đổi sang Pha 0–3 |
| 0.10 Việc lãnh đạo cần chốt | SỬA | Ch.1.5 | Bỏ 17 ADR. Thêm quyết định chi phí, hợp đồng |
| 0.11 Dàn bài thuyết trình | CHUYỂN | Phụ lục | Dùng khi làm slide |

### Chương 1 — Bối cảnh và mục đích

| Mục | Quyết định | Đích đến | Ghi chú |
|---|---|---|---|
| 1.1 Bản chất AI | GIỮ | Phần 0 (0.3) | Rút gọn |
| 1.2 Ba loại công việc | SỬA | Phần 0 | Rút còn 1 bảng |
| 1.3 Từ "viết" sang "đặc tả và kiểm chứng" | GIỮ | Phần 0 (0.4) | Nguyên tắc cốt lõi |
| 1.4 Bài toán thực tế | GIỮ | Ch.1 | |
| 1.5 Mục tiêu và giá trị | SỬA | Ch.1.4 | Thêm chỉ số đo được |
| 1.6 Áp dụng theo SDLC và vai trò | SỬA | Ch.8 | Làm "bản đồ" dẫn vào 6 chương playbook |
| 1.7 Ví dụ bảo trì thiết bị | BỎ | — | Thay bằng ví dụ dự án khách Nhật |
| 1.8 Nền tảng quản lý AI | CHUYỂN | Tài liệu kỹ thuật | |
| 1.9 Phạm vi, cách đọc | SỬA | Phần 0 (0.1) | Viết lại theo 2 nhóm người đọc |
| 1.10 Thông điệp chính | BỎ | — | Trùng 0.2 |

### Chương 2 — Thuật ngữ

| Mục | Quyết định | Đích đến | Ghi chú |
|---|---|---|---|
| 2.1–2.7 | SỬA | Phần 0 (0.2) | Giữ khoảng 40 thuật ngữ hay dùng. Thêm cột tiếng Nhật |
| 2.8 Cặp khái niệm dễ nhầm | GIỮ | Phụ lục | Rút còn 10 cặp |
| 2.9 Mã chuẩn | SỬA | Phần 0 (0.5) | Viết lại theo mục 2 của file này |

### Chương 3 — Tổng quan

| Mục | Quyết định | Đích đến | Ghi chú |
|---|---|---|---|
| 3.1 Agentic SDLC là gì | GIỮ | Phần 0 | |
| 3.2 Ranh giới AI và con người | GIỮ | Ch.4 | Nội dung cốt lõi |
| 3.3 Mức tự chủ và risk tier | SỬA | Ch.4 | Đổi L0–L4 → Mức 0–3 |
| 3.4 Intent articulation | SỬA | Ch.8, Ch.9 | Rút gọn. Chi tiết đưa vào Template T1 |
| 3.5 Vòng đời 10 giai đoạn | SỬA | Ch.8 | Đổi sang 6 giai đoạn |
| 3.6 Mô hình các plane | CHUYỂN | Tài liệu kỹ thuật | |
| 3.7 Nguyên tắc nền tảng | GIỮ | Phần 0 (0.4) | |
| 3.8 Mô hình trưởng thành | GIỮ | Ch.1 | Rút gọn |
| 3.9 Cân nhắc và thách thức | SỬA | Ch.1.3 | Gộp vào phần rủi ro |

### Chương 4 — Kiến trúc logic

| Mục | Quyết định | Đích đến | Ghi chú |
|---|---|---|---|
| 4.1–4.7, 4.9, 4.10, 4.15, 4.16 | CHUYỂN | Tài liệu kỹ thuật | Kiến trúc platform |
| 4.8 Mô hình Control Gate | SỬA | Ch.8 | Chỉ lấy ý "gate trả về quyết định gì". Bỏ chuỗi G0–G12 |
| 4.11 Artifact, provenance, evidence | SỬA | Ch.15, Template T2 | Lấy phần "ghi nguồn gốc output AI" |
| 4.12 Audit, observability | SỬA | Ch.14 | Lấy phần ghi log thao tác agent |
| 4.13 Vai trò agent, multi-agent | CHUYỂN | Tài liệu kỹ thuật | Pilot chưa dùng multi-agent |
| 4.14 Bảo mật, threat model | SỬA | Ch.3 | Giữ phần OWASP ASI01–ASI10. Bỏ phần kiến trúc |

### Chương 5 — Thiết kế vật lý và stack

| Mục | Quyết định | Đích đến | Ghi chú |
|---|---|---|---|
| 5.1 Build vs buy | SỬA | Ch.7 | Rút còn 1 trang. Nghiêng về "buy" cho SME |
| 5.2–5.7 | CHUYỂN | Tài liệu kỹ thuật | |
| 5.8 MVP / Enterprise / High-assurance | SỬA | Ch.7 | Chỉ giữ mức MVP, đổi sang AWS |
| 5.9 Ví dụ TypeScript/Node.js | SỬA | Ch.11 | Làm ví dụ cấu hình agent |
| 5.10 Stack 2026 | SỬA | Ch.7 | Kiểm tra lại tên và giá công cụ trước khi dùng |

### Chương 6 — Cơ chế làm việc (nguồn chính cho Phần II)

| Mục | Quyết định | Đích đến | Ghi chú |
|---|---|---|---|
| 6.1 Quy trình 10 giai đoạn | SỬA | Ch.9–14 | Tách thành 6 chương theo khuôn 9 mục |
| 6.2 Agentic Sprint, 8 gate | GIỮ | Ch.8 | Nguồn chính cho G1–G8. Bỏ cột mã G0–G12 |
| 6.3 Gate theo rủi ro | GIỮ | Ch.8 | Rút gọn |
| 6.4 Quản lý intent, agent run | SỬA | Ch.11 | Rút gọn |
| 6.5 Kiểm soát artifact AI | GIỮ | Ch.15 | |
| 6.6 Verification độc lập | GIỮ | Ch.12 | Nguồn chính cho gate G6 |
| 6.7 Human review | GIỮ | Ch.15 | Nguồn chính cho gate G7 |
| 6.8 Policy enforcement | SỬA | Ch.4 | Chỉ giữ nguyên tắc. Bỏ code policy |
| 6.9 Log và lịch sử làm việc | SỬA | Ch.14 | Rút gọn |
| 6.10 Tích hợp công cụ quản lý dự án | GIỮ | Ch.8 | Thêm Backlog (khách Nhật hay dùng) nếu công ty dùng |
| 6.11 Rubric, grader | CHUYỂN | Tài liệu kỹ thuật | |
| 6.12 AI debt | GIỮ | Ch.14 | |
| 6.13 Tái lập, chi phí | SỬA | Ch.7 | |
| 6.14 Ví dụ luồng hoàn chỉnh | SỬA | Ch.8 | Đổi mã. Đổi sang ví dụ dự án thật |

### Chương 7 — Đánh giá platform

| Mục | Quyết định | Đích đến | Ghi chú |
|---|---|---|---|
| 7.3 Bộ chỉ số | SỬA | Ch.7.2, Ch.8.5 | Chọn 5–7 chỉ số đo tay được |
| 7.9 Sẵn sàng production | SỬA | Ch.13 | Làm checklist release |
| 7.1, 7.2, 7.4–7.8, 7.10 | CHUYỂN | Tài liệu kỹ thuật | |

### Chương 8 — Vai trò mới

| Mục | Quyết định | Đích đến | Ghi chú |
|---|---|---|---|
| 8.1 Phân vai người và AI | GIỮ | Ch.5 | Nguồn cho RACI |
| 8.2, 8.3 Năng lực, vai trò | SỬA | Ch.5 | Rút về bảng vai trò kiêm nhiệm |
| 8.4 Cognitive debt | GIỮ | Ch.2 | Rủi ro junior phụ thuộc AI |
| 8.5 Thời gian, đào tạo | SỬA | Ch.2 | Điều kiện được dùng AI |
| 8.6–8.8 Rubric năng lực | CHUYỂN | Khung năng lực (tài liệu riêng) | |
| 8.9 Bản tối giản 90 ngày | GIỮ | Ch.2 | Hợp SME |

### Chương 9 — Lộ trình

| Mục | Quyết định | Đích đến | Ghi chú |
|---|---|---|---|
| 9.1 Milestone M0–M4 | SỬA | Ch.7.3 | Đổi sang Pha 0–3 |
| 9.2 Quyết định sớm, Decision Log | SỬA | Ch.1.5, Template | Giữ Decision Log |
| 9.3 Anti-pattern | GIỮ | Ch.1.3 | |
| 9.4 Kết luận | BỎ | — | |

### Phụ lục

| Mục | Quyết định | Ghi chú |
|---|---|---|
| A Schema, policy, code | CHUYỂN | Tài liệu kỹ thuật |
| B Rubric chi tiết | CHUYỂN | Khung năng lực |
| C Checklist | SỬA | Chọn lọc làm Template T3, T4 |
| D Bảng tra cứu | SỬA | Chỉ giữ bảng đổi mã |
| E Bản đồ 34 chủ đề gốc | CHUYỂN | Tài liệu kỹ thuật |
| F Nguồn trích dẫn | GIỮ | Lọc bỏ nguồn yếu (blog, forum) |

---

## 4. Phần cần THÊM mới

| # | Nội dung | Đích đến | Nguồn dự kiến |
|---|---|---|---|
| 1 | Chính sách dùng AI: công cụ được phép, tài khoản doanh nghiệp | Ch.2 | [Đề xuất] |
| 2 | Phân loại dữ liệu khách hàng, việc cấm đưa vào AI | Ch.3 | [Đề xuất] |
| 3 | Rà hợp đồng/NDA với khách Nhật trước khi dùng AI | Ch.3, T7 | [Bên ngoài] METI checklist |
| 4 | Đối chiếu hướng dẫn AI của METI/MIC bản 1.2 | Ch.6 | [Bên ngoài] |
| 5 | RACI khi một người kiêm nhiều vai | Ch.5, T5 | [Đề xuất] |
| 6 | Chương Kiểm thử theo khuôn 9 mục | Ch.12 | Lấy từ 6.6 + [Đề xuất] |
| 7 | Chương Triển khai theo khuôn 9 mục | Ch.13 | Lấy từ 6.1 (S8) + 7.9 |
| 8 | Hướng dẫn theo stack công ty (React/Vue/Angular, Node.js, Kotlin, .NET) | Ch.11 | [Đề xuất] |
| 9 | Đổi stack Supabase sang AWS | Ch.7 | [Đề xuất] |
| 10 | Bảng thuật ngữ Việt–Anh–Nhật | Phần 0, Phụ lục | [Đề xuất] |

---

## 5. Rủi ro khi bật đủ 8 gate trong pilot

- [Đề xuất] Đây là rủi ro lớn nhất của pilot. 8 gate dễ làm đội thấy chậm và bỏ quy trình.
- [Tài liệu] Chính file gốc khuyên nên bắt đầu với 4 gate.

Cách giảm tải mà vẫn giữ đủ 8 gate:
- **Tự động hóa G4, G5.** Dùng cấu hình sandbox, branch protection, giới hạn quyền. Người chỉ duyệt khi agent xin vượt quyền.
- **Tự động hóa G6.** CI chạy test, lint, quét bảo mật. Người chỉ xem khi CI báo lỗi.
- **Gate người duyệt thật chỉ còn 5:** G1, G2, G3, G7, G8.
- **Gate = checklist 3–5 câu.** Không cần biên bản dài.
- **Một người được duyệt nhiều gate.** Nhưng không tự duyệt việc chính mình làm.
- **Đo thời gian chờ ở mỗi gate.** Gate nào chờ lâu thì xem lại sau 2 tuần.

---

## 6. Cấu trúc Git repo đề xuất

```text
agentic-sdlc-framework/
├── README.md                  # Cách đọc, ai đọc chương nào
├── CHANGELOG.md               # Lịch sử phiên bản
├── 00-mo-dau/                 # Phần 0: thuật ngữ, nguyên tắc, bảng mã
├── 01-chinh-sach/             # Phần I: Ch.1–7 (lãnh đạo)
├── 02-playbook/               # Phần II: Ch.8–15 (đội thực thi)
├── 03-templates/              # Phần III: T1–T9
├── phu-luc/
├── diagrams/
│   ├── src/                   # *.mmd (nguồn Mermaid)
│   └── svg/                   # *.svg (xuất tự động)
├── tai-lieu-ky-thuat/         # Phần CHUYỂN ra từ Ch.4, 5, 7
└── .github/workflows/
    └── render-diagrams.yml    # Xuất SVG khi có thay đổi
```

- [Đề xuất] Sơ đồ viết thẳng trong file .md (GitHub/GitLab hiển thị được Mermaid).
- [Đề xuất] Bản SVG xuất bằng mermaid-cli (lệnh `mmdc`) chạy trong CI. Dùng cho slide và bản in.
- [Đề xuất] Mọi sửa đổi handbook đi qua Pull Request. Chủ handbook duyệt.

---

## 7. Việc còn mở

- Chốt danh sách các mục ghi "CHUYỂN". Có giữ tài liệu kỹ thuật nền tảng trong cùng repo không?
- Chọn dự án pilot. Khách hàng đó có cho phép dùng AI không?
- Ai là chủ handbook (người duyệt PR)?
- Ví dụ minh họa: dùng dự án thật (ẩn tên khách) hay dự án giả định?

---

## Lịch sử phiên bản

| Phiên bản | Ngày | Người | Nội dung |
|---|---|---|---|
| 0.1 | 24/09/2026 | Claude (đề xuất) | Bản review đầu tiên, chờ Harry duyệt |
