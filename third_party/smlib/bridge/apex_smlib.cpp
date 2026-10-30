// Apex <-> SMLib bridge: exact BRep booleans on planar polyhedra.
//
// Input: nsolids planar polyhedra sharing one point array (xyz doubles).
// ints layout per solid: nfaces, then per face: nloops, then per loop:
// nverts, vertex indices... (first loop = outer, CCW seen from outside).
// ops[i] (i >= 1) combines solid i into the running result:
// 0 = union, 1 = difference, 2 = intersection.
// Output: triangles of the result, read back with apex_sm_points/tris.
#include <SmSmlibAll.h>
#include <SmPoly.h>
#include <SmApiGeneral.h>
#include <SmApiBrep.h>
#include <SmApiCurves.h>
#include <SmApiQueries.h>
#include <SmApiTrimmedSurfaces.h>
#include <SmApiPolygons.h>
#include <unordered_map>
#include <vector>

namespace {
std::vector<double> g_pts;
std::vector<int> g_tri;
double g_volume = 0.0;
int g_failed_step = -1;
bool g_init = false;

void init() {
  if (!g_init) { SmApiCreateContext(); g_init = true; }
}

// One planar face (outer loop + holes) added to `brep`.
bool add_face(SmBrep* brep, const double* p, const int*& it) {
  int nloops = *it++;
  SmTArray<SmCurve*> curves;
  bool ok = true;
  for (int l = 0; l < nloops; ++l) {
    int nv = *it++;
    const int* idx = it;
    it += nv;
    for (int k = 0; k < nv && ok; ++k) {
      const double* a = p + 3 * idx[k];
      const double* b = p + 3 * idx[(k + 1) % nv];
      SmLine* line = nullptr;
      if (SmApiCreateLineSegment(SmPoint3d(a[0], a[1], a[2]), SmPoint3d(b[0], b[1], b[2]), line) != SM_SUCCESS || !line)
        ok = false;
      else
        curves.Add(line);
    }
  }
  SmTArray<SmFace*> made;
  if (ok) ok = brep->CreatePlanarFacesWith3DCurves(brep->GetInfiniteRegion(), curves, 0.01, made) == SM_SUCCESS && made.GetSize() > 0;
  if (!ok) {
    // Curves held by created edges belong to the brep; free only loose ones.
    SmTArray<SmEdge*> edges;
    brep->GetEdges(edges);
    for (ULONG c = 0; c < curves.GetSize(); ++c) {
      bool held = false;
      for (ULONG e = 0; e < edges.GetSize() && !held; ++e) held = edges[e]->GetCurve() == curves[c];
      if (!held) delete curves[c];
    }
  }
  return ok;
}

// Skip one face's encoding without building it.
void skip_face(const int*& it) {
  int nloops = *it++;
  for (int l = 0; l < nloops; ++l) { int nv = *it++; it += nv; }
}

SmBrep* make_solid(const double* p, const int*& it) {
  int nfaces = *it++;
  SmBrep* brep = new (*SmApiGetOrCreateContext()) SmBrep();
  bool ok = nfaces >= 4;
  for (int f = 0; f < nfaces; ++f) {
    if (ok) ok = add_face(brep, p, it);
    else skip_face(it);
  }
  if (!ok) { delete brep; return nullptr; }
  SmBoolean solid = FALSE;
  ULONG stitched = 0;
  double vgap = 0, egap = 0;
  SmApiStatus st = SmApiStitchIntoSolid(brep, solid, stitched, vgap, egap);
  if (st != SM_SUCCESS || !solid) { delete brep; return nullptr; }
  return brep;
}

bool tessellate(SmBrep* b, double chord) {
  SmPolyBrep* poly = nullptr;
  SmTessellationParams prm;
  prm.dChordHeightTol = chord;
  if (SmApiTessellate(b, poly, prm) != SM_SUCCESS || !poly) return false;
  SmTArray<SmPolyVertex*> vs;
  SmTArray<SmPolyFace*> fs;
  poly->GetPolyVertices(vs);
  poly->GetPolyFaces(fs);
  std::unordered_map<SmPolyVertex*, int> idx;
  for (ULONG i = 0; i < vs.GetSize(); ++i) {
    idx[vs[i]] = (int)i;
    SmPoint3d q = vs[i]->GetPoint();
    g_pts.push_back(q.x); g_pts.push_back(q.y); g_pts.push_back(q.z);
  }
  for (ULONG i = 0; i < fs.GetSize(); ++i) {
    SmPolyLoop* loop = fs[i]->GetOuterPolyLoop();
    if (!loop) continue;
    SmTArray<SmPolyEdge*> es;
    loop->GetPolyEdges(es);
    for (ULONG j = 1; j + 1 < es.GetSize(); ++j) {
      g_tri.push_back(idx[es[0]->GetStartPolyVertex()]);
      g_tri.push_back(idx[es[j]->GetStartPolyVertex()]);
      g_tri.push_back(idx[es[j + 1]->GetStartPolyVertex()]);
    }
  }
  delete poly;
  return true;
}
}  // namespace

extern "C" {

// 0 on success; -(1 + i) when solid i cannot be built; -(100 + i) when the
// boolean with solid i fails; -1000 when tessellation fails.
int apex_sm_run(const double* pts, const int* ints, int nsolids, const int* ops, double chord) {
  init();
  g_pts.clear(); g_tri.clear(); g_volume = 0.0; g_failed_step = -1;
  if (nsolids < 1) return -1;
  const int* it = ints;
  SmBrep* acc = make_solid(pts, it);
  if (!acc) return -1;
  for (int i = 1; i < nsolids; ++i) {
    SmBrep* b = make_solid(pts, it);
    if (!b) { delete acc; return -(1 + i); }
    SmBooleanOperationType op = ops[i] == 0 ? SM_BO_UNION : ops[i] == 2 ? SM_BO_INTERSECTION : SM_BO_DIFFERENCE;
    SmBrep* r = nullptr;
    if (SmApiBoolean(acc, b, op, r) != SM_SUCCESS || !r) {
      delete acc; delete b; return -(100 + i);
    }
    acc = r;
  }
  SmApiBrepComputeVolume(acc, 1e-9, g_volume);
  bool ok = tessellate(acc, chord);
  delete acc;
  return ok ? 0 : -1000;
}

const double* apex_sm_points() { return g_pts.data(); }
int apex_sm_npoints() { return (int)(g_pts.size() / 3); }
const int* apex_sm_tris() { return g_tri.data(); }
int apex_sm_ntris() { return (int)(g_tri.size() / 3); }
double apex_sm_volume() { return g_volume; }
}
