# ExamcureBe

ExamcureBe quản lý tài khoản, phiên đăng nhập, quyền admin, môn học, tài liệu,
câu hỏi và đề thi. Toàn bộ dữ liệu ứng dụng và vector nằm trong MongoDB.
Production dùng MongoDB replica set/Atlas và S3 riêng tư; local dùng MongoDB
replica set Docker và thư mục file của BE.
Supabase không còn là dependency hay dịch vụ runtime.

## Chạy local

Yêu cầu Node.js 24+. Sao chép `.env.example` thành `.env`, đặt JWT secret rồi:

```sh
npm ci
docker compose up -d --wait
npm run dev
```

API: `http://localhost:5010/api/v1`; Swagger: `/api-docs`. Collections/indexes được
tạo idempotent khi khởi động. Production bắt buộc MongoDB replica set/Atlas,
S3/SMTP/HTTPS/secret. API từ chối MongoDB standalone vì auth/admin dùng transaction.

FE dùng `NEXT_PUBLIC_API_URL=/api/v1`, `EXAMCURE_API_URL=http://localhost:5010`.
BE đặt `CORS_ORIGIN=http://localhost:3000`,
`API_PUBLIC_URL=http://localhost:3000/api/v1`. Next.js chuyển tiếp API để refresh
cookie thuộc origin FE.

## Auth và admin

- `/Auth/register`: đăng ký và đăng nhập ngay (trả access token + refresh cookie
  HttpOnly như login), không cần xác thực email. `/Auth/verify-otp`,
  `/Auth/resend-otp` chỉ còn cho tài khoản cũ chưa xác thực (legacy).
- `/Auth/login`, `/Auth/refresh`, `/Auth/logout`: access JWT và refresh cookie
  HttpOnly; refresh token không trả trong JSON. Logout/reset vô hiệu hóa phiên
  trên server. Refresh giữ session ID để các tab khác không mất access token.
- `/Auth/forgot-password`, `/Auth/reset-password`: OTP đặt lại mật khẩu; không
  tạo phiên phục hồi. Local không có SMTP sẽ in OTP ở terminal; production
  bắt buộc SMTP trừ khi đặt `OTP_DELIVERY=log` (tạm thời: OTP in ra log server);
  OTP không bao giờ được trả trong JSON.
- `/Auth/google/start`, `/Auth/google/callback`: authorization code, state/PKCE.
  Điền đủ ba biến Google trong BE, bật `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=true`
  ở FE. Redirect URI: `https://<frontend>/api/v1/Auth/google/callback`.
- `/Users/me`: hồ sơ/quyền hiện tại. Role trong browser không cấp quyền API.
- `/Admin/*`: JWT hợp lệ và role admin trong MongoDB. Setup secret chỉ dùng tại
  `/Admin/bootstrap`, không thay session. Bootstrap khóa một lần trong
  transaction; API ngăn tự hạ quyền và đồng thời loại bỏ hết admin.

Để tạo admin: đăng ký/xác thực tài khoản, đặt `ADMIN_BOOTSTRAP_TOKEN` ngẫu nhiên
32–512 ký tự và `ADMIN_BOOTSTRAP_EXPIRES_AT` là ISO timestamp có timezone còn
hạn. Đăng nhập, mở `/admin`, dùng biểu mẫu khởi tạo rồi bỏ hai biến setup.
Nếu import có admin, bootstrap tự khóa.

## Nội dung và file

Tạo metadata tại `/Admin/materials`, upload bytes qua PUT `uploadPath`, rồi gọi
`complete-upload`. BE kiểm tra dung lượng thực, chữ ký ZIP, trạng thái và giới
hạn 20 MB. File gốc riêng tư. Sinh viên đọc slide text và lấy URL tải ký 60 giây;
URL bị thu hồi khi logout/reset phiên cấp URL.

`MATERIAL_PROCESSING_MODE=inline` index text PPTX ngay trên API.
`worker` đưa vào queue MongoDB, trả 202; worker chuyển PDF/PNG bằng
LibreOffice/Poppler rồi index MongoDB. API/worker dùng cùng MongoDB/S3.
Worker local: `npm run worker:materials`.

## Kiểm tra

```sh
npm test
npm run test:materials
npm run test:database
npm run build
```

`npm test` và `test:database` tạo rồi dừng MongoDB 8.0 replica set Docker riêng,
không dùng database thật. Test bao gồm auth/admin, refresh/bootstrap cạnh tranh, version
counters, review/đề, rollback và giữ mật khẩu bcrypt khi import.

[Cấu hình hạ tầng](docs/AI_BACKEND_SETUP.md) và
[chuyển dữ liệu cũ](docs/REMOVE_SUPABASE.md).
`render.yaml` có web service và worker tùy chọn; chưa triển khai tài nguyên nào.
