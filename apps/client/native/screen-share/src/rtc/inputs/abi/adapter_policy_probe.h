#pragma once

namespace monky::native_rtc {
void VerifyDeviceFreeAdapterPolicies(void (*check)(bool, const char*) = nullptr);
}
