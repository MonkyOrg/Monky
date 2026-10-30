#pragma once

#include "surface_recycler.h"

#include <memory>

namespace monky::screen_video {

// Surfaces are shared_ptr<int> here: the value proves which one came back,
// and an expired weak_ptr proves that a refused or evicted one was released.
template <typename Check>
void RunSurfaceRecyclerChecks(Check check) {
  using Surface = std::shared_ptr<int>;
  const SurfaceSize hd{1920, 1080}, uhd{3840, 2160};
  const auto surface = [](int value) { return std::make_shared<int>(value); };

  SurfaceRecycler<Surface> surfaces(2);
  check(!surfaces.Take(hd), "An empty recycler invented a surface");
  surfaces.Return(surface(1), hd, surfaces.Generation());
  check(surfaces.Kept() == 1 && !surfaces.Take(uhd), "A kept surface served another frame size");
  auto taken = surfaces.Take(hd);
  check(taken && **taken == 1 && surfaces.Kept() == 0,
        "A released surface must serve the next frame of its size instead of a new allocation");

  surfaces.Return(surface(2), hd, surfaces.Generation());
  surfaces.Return(surface(3), hd, surfaces.Generation());
  taken = surfaces.Take(hd);
  check(taken && **taken == 3, "The most recently released surface must be reused first");
  taken = surfaces.Take(hd);
  check(taken && **taken == 2 && !surfaces.Take(hd), "Every kept surface must be reused exactly once");

  auto oldest = surface(4);
  const std::weak_ptr<int> oldest_alive = oldest;
  surfaces.Return(std::move(oldest), uhd, surfaces.Generation());
  surfaces.Return(surface(5), hd, surfaces.Generation());
  surfaces.Return(surface(6), hd, surfaces.Generation());
  check(surfaces.Kept() == 2 && oldest_alive.expired() && !surfaces.Take(uhd),
        "A full recycler must release its oldest surface, so a size that stopped arriving leaves");
  taken = surfaces.Take(hd);
  check(taken && **taken == 6, "Making room must keep the surfaces released last");

  const auto before_clear = surfaces.Generation();
  const std::weak_ptr<int> cleared = *surfaces.Take(hd);
  check(cleared.expired(), "A taken surface stayed owned by the recycler");
  auto kept = surface(7);
  const std::weak_ptr<int> kept_alive = kept;
  surfaces.Return(std::move(kept), hd, before_clear);
  surfaces.Clear();
  check(surfaces.Kept() == 0 && kept_alive.expired(), "Clear must release every kept surface");
  auto late = surface(8);
  const std::weak_ptr<int> late_alive = late;
  surfaces.Return(std::move(late), hd, before_clear);
  check(surfaces.Kept() == 0 && late_alive.expired(),
        "A surface handed out before Clear must be released when its frame ends, not kept");
  surfaces.Return(surface(9), hd, surfaces.Generation());
  taken = surfaces.Take(hd);
  check(taken && **taken == 9, "Surfaces handed out after Clear must be kept again");

  SurfaceRecycler<Surface> none(0);
  auto refused = surface(10);
  const std::weak_ptr<int> refused_alive = refused;
  none.Return(std::move(refused), hd, none.Generation());
  check(none.Kept() == 0 && refused_alive.expired(), "A recycler without capacity kept a surface");
}

}  // namespace monky::screen_video
