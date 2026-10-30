#pragma once
#include <cstdlib>
inline void* scalable_malloc(size_t n){return std::malloc(n);} inline void scalable_free(void*p){std::free(p);}
inline void* scalable_calloc(size_t a,size_t b){return std::calloc(a,b);} inline void* scalable_realloc(void*p,size_t n){return std::realloc(p,n);}
