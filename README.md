# ExamCure Backend

Node.js/TypeScript API tương thích với `ExamCureUI`. Mặc định server chạy tại
`http://localhost:5010`, API prefix là `/api/v1`, Swagger UI ở `/api-docs`.

Supabase là cơ sở dữ liệu chính cho auth, tài liệu, câu hỏi và đề thi. MongoDB
Atlas chỉ lưu chunk/embedding dẫn xuất để tìm kiếm vector. Ở chế độ miễn phí,
Render API trích text/note của `.pptx` và lập chỉ mục ngay trong request; không
cần Worker PowerPoint.

## Chạy local

Yêu cầu Node.js 24+. Supabase Auth là mặc định ở cả local và production.
SQLite và các endpoint auth cũ chỉ được mở khi đặt rõ
`ENABLE_LEGACY_AUTH=true` cho kiểm thử tương thích hoặc chuyển đổi dữ liệu;
frontend hiện tại chỉ sử dụng Supabase Auth.

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

File SQLite tương thích được tạo tại `data/examcure.sqlite`. Frontend mặc định gọi
`http://localhost:5010/api/v1`; nếu cần đổi, đặt `NEXT_PUBLIC_API_URL` trong UI.
Để dùng pipeline AI, làm theo [hướng dẫn Supabase/MongoDB](docs/AI_BACKEND_SETUP.md).

## API chính

| Method | Endpoint | Mô tả |
| --- | --- | --- |
| POST | `/api/v1/Auth/register` | Đăng ký và gửi OTP |
| POST | `/api/v1/Auth/verify-otp` | Xác thực email, nhận token |
| POST | `/api/v1/Auth/resend-otp` | Gửi lại OTP |
| POST | `/api/v1/Auth/login` | Đăng nhập email/mật khẩu |
| POST | `/api/v1/Auth/google-login` | Đăng nhập bằng Google access token |
| POST | `/api/v1/Auth/refresh` | Xoay refresh token |
| POST | `/api/v1/Auth/logout` | Thu hồi refresh token |
| POST | `/api/v1/Auth/forgot-password` | Yêu cầu mã đặt lại mật khẩu |
| POST | `/api/v1/Auth/reset-password` | Đặt lại mật khẩu bằng OTP |
| GET/PATCH | `/api/v1/Users/me` | Đọc/cập nhật hồ sơ (Bearer JWT) |
| GET | `/api/v1/System/status` | Kiểm tra cấu hình tích hợp, không trả secret |
| GET/POST/PATCH | `/api/v1/Admin/*` | Quản trị môn, tài liệu, AI, câu hỏi và đề thi (Supabase admin) |
| GET | `/api/v1/Materials` | Danh sách giáo trình READY của môn học (Supabase session) |
| GET | `/api/v1/Materials/{versionId}/slides` | Text/note slide để xem trực tiếp, không cần Worker |
| GET | `/api/v1/Materials/{versionId}/download` | Link tải `.pptx` private có hạn 60 giây |

Các endpoint `/Auth/*` và `/Users/me` trong bảng thuộc chế độ tương thích,
không được mở mặc định. Khi bật chế độ này, OTP được in ra console và trả
trong JSON ở `development`/`test` khi `DEV_EXPOSE_OTP=true`; production bắt buộc
cấu hình SMTP. Với luồng chính, Supabase Auth gửi email và quản lý token.

## Kiểm tra

```powershell
npm run typecheck
npm test
npm run test:materials
npm run build
```

Kiểm tra migration bootstrap bằng PostgreSQL 16 riêng trong Docker:
`npm run test:admin-bootstrap`. Lệnh tạo container tạm không có network/port
public, chạy test quyền và request đồng thời, rồi tự xóa container.

## Deploy Render

Repo có sẵn `render.yaml` cho Render Web Service. Với production dùng Supabase
Auth, backend mặc định đặt `ENABLE_LEGACY_AUTH=false`; khi đó không mở các route
`/Auth/*`, `/Users/me` cũ và không yêu cầu SMTP. Các secret Supabase, MongoDB,
OpenAI và `CORS_ORIGIN` phải nhập trong Render Dashboard.

Frontend và backend phải dùng cùng project Supabase. Frontend đặt
`NEXT_PUBLIC_API_URL=https://<your-render-service>.onrender.com/api/v1` và
anon/publishable key; Render giữ `SUPABASE_SERVICE_ROLE_KEY`. Cập nhật
Supabase Auth redirect URLs theo domain frontend để Google OAuth quay về
đúng trang. Tài khoản SQLite cũ không được tự động chuyển sang Supabase.

Bootstrap không còn là token truy cập API admin. Để cấp admin đầu tiên, áp dụng
migration `202610100001_admin_bootstrap.sql`, đặt secret và hạn dùng
`ADMIN_BOOTSTRAP_EXPIRES_AT`, rồi dùng tài khoản Supabase đã đăng nhập tại
`/admin`. Xem hướng dẫn khởi tạo trong `docs/AI_BACKEND_SETUP.md`.

Nếu service đã được tạo thủ công, `render.yaml` không tự cập nhật Environment
của service đó. Hãy thêm các biến theo `docs/AI_BACKEND_SETUP.md`, đặt Build
Command thành `npm ci --include=dev && npm run build`, sau đó chọn
**Manual Deploy → Deploy latest commit**.

Chế độ mặc định không cần Worker: chỉ nhận `.pptx` tối đa 20 MB và không tạo
PDF/ảnh slide. Docker Background Worker với LibreOffice/Poppler vẫn có sẵn cho
nhu cầu đó; Render không cung cấp Background Worker miễn phí. Xem mục 9 trong
`docs/AI_BACKEND_SETUP.md`.

## Ghi chú bảo mật

- Nếu bật `ENABLE_LEGACY_AUTH`, đổi `JWT_SECRET` thành chuỗi ngẫu nhiên mạnh.
- Đặt `GOOGLE_CLIENT_ID` để backend kiểm tra audience của Google access token.
- Chỉ thêm đúng origin frontend vào `CORS_ORIGIN` (phân cách bằng dấu phẩy).
- Chỉ cần SMTP khi bật auth cũ; không bật `DEV_EXPOSE_OTP` trong production.
- Refresh token được lưu dưới dạng hash và xoay vòng sau mỗi lần dùng.
