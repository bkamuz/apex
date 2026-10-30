#pragma once
#include <cstddef>
#include <utility>
namespace tbb {
template<class I, class F> void parallel_for(I b, I e, const F& f){ for(I i=b;i<e;++i) f(i); }
template<class I, class F> void parallel_for(I b, I e, I s, const F& f){ for(I i=b;i<e;i+=s) f(i); }
template<class R, class F> auto parallel_for(const R& r, const F& f) -> decltype(r.begin(), void()) { f(r); }
struct task_arena { task_arena(int=0){} template<class F> auto execute(F&& f){ return f(); } };
}
