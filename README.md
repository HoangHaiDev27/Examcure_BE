# ExamCure Backend

Node.js/TypeScript API tương thích với `ExamCureUI`. Mặc định server chạy tại
`http://localhost:5010`, API prefix là `/api/v1`, Swagger UI ở `/api-docs`.

## Chạy local

Yêu cầu Node.js 24+ (backend dùng SQLite tích hợp trong Node).

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Không cần cài database hay chạy Docker. File dữ liệu local được tạo tại
`data/examcure.sqlite`. Frontend đã mặc định gọi
`http://localhost:5010/api/v1`; nếu cần đổi, đặt `NEXT_PUBLIC_API_URL` trong UI.

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

Trong `development`/`test`, OTP được in ra console và trả trong JSON khi
`DEV_EXPOSE_OTP=true`. Production không trả OTP và bắt buộc có SMTP.

## Kiểm tra

```powershell
npm run typecheck
npm test
npm run build
```

## Ghi chú bảo mật

- Đổi `JWT_SECRET` thành chuỗi ngẫu nhiên mạnh trước khi deploy.
- Đặt `GOOGLE_CLIENT_ID` để backend kiểm tra audience của Google access token.
- Chỉ thêm đúng origin frontend vào `CORS_ORIGIN` (phân cách bằng dấu phẩy).
- Cấu hình SMTP trong production; không bật `DEV_EXPOSE_OTP`.
- Refresh token được lưu dưới dạng hash và xoay vòng sau mỗi lần dùng.
