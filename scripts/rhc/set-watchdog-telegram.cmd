@echo off
rem Sets the two Telegram secrets on the RHC watchdog (flipthememe-watchdog-rhc).
rem Nothing secret is stored in this file: you paste the values at the prompts (the input
rem is hidden) and wrangler sends them straight to Cloudflare.
cd /d C:\Server\memepred\workers
echo.
echo The chat id is a number. It is on this line of your Hermes env, copy the digits after the equals sign:
findstr /b "TG_BOT_CHAT=" "%USERPROFILE%\.hermes\.env"
echo.
echo 1 of 2: paste the BOT TOKEN and press Enter (nothing is shown while you paste, that is normal)
call npx wrangler secret put TELEGRAM_BOT_TOKEN -c wrangler.watchdog.rhc.toml
echo.
echo 2 of 2: paste the CHAT ID and press Enter
call npx wrangler secret put TELEGRAM_CHAT_ID -c wrangler.watchdog.rhc.toml
echo.
echo Secrets now on the watchdog (names only):
call npx wrangler secret list -c wrangler.watchdog.rhc.toml
echo.
pause
