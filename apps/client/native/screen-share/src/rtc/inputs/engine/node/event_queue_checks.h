#pragma once

#include "event_queue.h"

#include <memory>
#include <initializer_list>

namespace monky::native_rtc::node {

template <typename Check>
void RunEventQueueChecks(Check&& check) {
  using Context = EventQueueContext<std::shared_ptr<unsigned>>;
  for (const unsigned count : {0u, 1u, 2u, 128u}) {
    for (unsigned before_finalizer = 0; before_finalizer <= count; ++before_finalizer) {
      auto owner = std::make_shared<unsigned>(606);
      const std::weak_ptr<unsigned> weak = owner;
      auto* context = new Context(owner);
      owner.reset();
      for (unsigned index = 0; index < count; ++index) context->RetainPending();
      check(context->Pending() == count, "Accepted queue items lost lifetime references");
      for (unsigned index = 0; index < before_finalizer; ++index)
        check(!context->ReleasePending(), "Queue disposal alone fabricated finalizer/drain proof");
      check(context->MarkFinalized() == (before_finalizer == count),
            "Finalizer fabricated drain while accepted items still awaited disposal");
      context->ReleaseFinalizer();
      if (before_finalizer != count) {
        check(!weak.expired(), "Early runtime finalizer freed queued callback context");
        for (unsigned index = before_finalizer; index < count; ++index) {
          check(*context->OwnerValue() == 606, "Post-finalizer disposal lost its owner");
          const bool drained = context->ReleasePending();
          check(drained == (index + 1 == count), "Only the final disposal may establish drain");
        }
      }
      check(weak.expired(), "Event context leaked after finalization and complete disposal");
    }
  }
  {
    auto owner = std::make_shared<unsigned>(606);
    const std::weak_ptr<unsigned> weak = owner;
    auto* context = new Context(owner);
    owner.reset();
    context->RetainPending();
    check(!context->ReleasePending() && context->Pending() == 0,
          "Rejected push left a queued-data reference or manufactured drain");
    check(!weak.expired(), "A napi_closing refusal consumed the separate finalizer context ref");
    check(context->MarkFinalized(), "An empty rejected queue did not finish at finalization");
    context->ReleaseFinalizer();
    check(weak.expired(), "Refused push leaked its independent context owner");
  }
}

}  // namespace monky::native_rtc::node
