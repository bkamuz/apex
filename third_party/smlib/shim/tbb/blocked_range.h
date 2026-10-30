#pragma once
#include <cstddef>
namespace tbb {
template<class V> struct blocked_range { V b,e; blocked_range(V b_,V e_,size_t=1):b(b_),e(e_){} V begin()const{return b;} V end()const{return e;} };
template<class R, class C=R> struct blocked_range2d { blocked_range<R> r; blocked_range<C> c;
 blocked_range2d(R rb,R re,C cb,C ce):r(rb,re),c(cb,ce){} blocked_range2d(R rb,R re,size_t,C cb,C ce,size_t):r(rb,re),c(cb,ce){}
 const blocked_range<R>& rows()const{return r;} const blocked_range<C>& cols()const{return c;} };
}
