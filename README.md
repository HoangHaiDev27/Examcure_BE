# ExamCure Backend

Node.js/TypeScript API tương thích với `ExamCureUI`. Mặc định server chạy tại
`http://localhost:5010`, API prefix là `/api/v1`, Swagger UI ở `/api-docs`.

Supabase là cơ sở dữ liệu chính cho auth, tài liệu, câu hỏi và đề thi. MongoDB
Atlas chỉ lưu chunk/embedding dẫn xuất để tìm kiếm vector. Worker PowerPoint và
mọi khóa bí mật đều thuộc repo backend này.

## Chạy local

Yêu cầu Node.js 24+. SQLite vẫn được giữ tạm cho các endpoint auth cũ; luồng
quản trị AI mới dùng Supabase Auth và Supabase PostgreSQL.

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

File dữ liệu auth cũ được tạo tại `data/examcure.sqlite`. Frontend mặc định gọi
`http://localhost:5010/api/v1`; nếu cần đổi, đặt `NEXT_PUBLIC_API_URL` trong UI.
Để dùng pipeline AI, làm theo [hướng dẫn Supabase/MongoDB/worker](docs/AI_BACKEND_SETUP.md).

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

Trong `development`/`test`, OTP được in ra console và trả trong JSON khi
`DEV_EXPOSE_OTP=true`. Production không trả OTP và bắt buộc có SMTP.

## Kiểm tra

```powershell
npm run typecheck
npm test
npm run test:materials
npm run build
```

## Deploy Render

Repo có sẵn `render.yaml` cho Render Web Service. Với production dùng Supabase
Auth, backend mặc định đặt `ENABLE_LEGACY_AUTH=false`; khi đó không mở các route
`/Auth/*`, `/Users/me` cũ và không yêu cầu SMTP. Các secret Supabase, MongoDB,
OpenAI và `CORS_ORIGIN` phải nhập trong Render Dashboard.

Nếu service đã được tạo thủ công, `render.yaml` không tự cập nhật Environment
của service đó. Hãy thêm các biến theo `docs/AI_BACKEND_SETUP.md`, đặt Build
Command thành `npm ci --include=dev && npm run build`, sau đó chọn
**Manual Deploy → Deploy latest commit**.

Worker PowerPoint là Docker Background Worker riêng vì cần LibreOffice và
Poppler; xem phần 8 trong `docs/AI_BACKEND_SETUP.md`. Render không cung cấp
Background Worker miễn phí.

## Ghi chú bảo mật

- Nếu bật `ENABLE_LEGACY_AUTH`, đổi `JWT_SECRET` thành chuỗi ngẫu nhiên mạnh.
- Đặt `GOOGLE_CLIENT_ID` để backend kiểm tra audience của Google access token.
- Chỉ thêm đúng origin frontend vào `CORS_ORIGIN` (phân cách bằng dấu phẩy).
- Chỉ cần SMTP khi bật auth cũ; không bật `DEV_EXPOSE_OTP` trong production.
- Refresh token được lưu dưới dạng hash và xoay vòng sau mỗi lần dùng.
