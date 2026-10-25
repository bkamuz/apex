//! Saved views and sheets on [`crate::project::Project`].

use crate::level::LevelId;
use crate::project::Project;
use crate::sheet::{
    PaperOrientation, PaperSize, Sheet, SheetError, SheetId, SheetViewport, SheetViewportId,
};
use crate::view::{
    StoredCamera, StoredProjection, View, ViewError, ViewId, ViewKind, ViewSettings,
};
use crate::view_annotation::ViewAnnotationId;

const DEFAULT_STOREY_RISE: f32 = 3.0;
const SHEET_VIEWPORT_MARGIN_MM: f32 = 12.0;

impl Project {
    pub fn views(&self) -> impl Iterator<Item = &View> {
        self.views.values()
    }

    pub fn get_view(&self, id: ViewId) -> Option<&View> {
        self.views.get(&id)
    }

    pub fn sheets(&self) -> impl Iterator<Item = &Sheet> {
        self.sheets.values()
    }

    pub fn get_sheet(&self, id: SheetId) -> Option<&Sheet> {
        self.sheets.get(&id)
    }

    /// Default plan + 3D views for a fresh or migrated project.
    pub fn ensure_default_views(&mut self) {
        if !self.views.is_empty() {
            return;
        }
        let level_id = self
            .document()
            .active_level_id()
            .or_else(|| {
                self.document()
                    .levels()
                    .min_by(|a, b| {
                        a.elevation
                            .partial_cmp(&b.elevation)
                            .unwrap_or(std::cmp::Ordering::Equal)
                            .then_with(|| a.name.cmp(&b.name))
                    })
                    .map(|l| l.id)
            })
            .expect("document always has a level");

        let level_name = self
            .document()
            .get_level(level_id)
            .map(|l| l.name.clone())
            .unwrap_or_else(|| "Level".into());

        let cut = self
            .document()
            .get_level(level_id)
            .map(|l| l.elevation)
            .unwrap_or(0.0);
        let top = cut + DEFAULT_STOREY_RISE;
        let bottom = cut - 0.5;

        let plan = View::new(
            format!("{level_name} — Plan"),
            ViewKind::Plan {
                level_id,
                cut_height: cut,
                view_range_top: top,
                view_range_bottom: bottom,
            },
        );
        let three_d = View::new(
            "3D View",
            ViewKind::ThreeD {
                camera: StoredCamera::default(),
                projection: StoredProjection::Perspective,
            },
        );
        self.views.insert(plan.id, plan);
        self.views.insert(three_d.id, three_d);
        self.view_counter = 2;
    }

    pub fn create_plan_view(&mut self, level_id: LevelId) -> Result<ViewId, ViewError> {
        if self.document().get_level(level_id).is_none() {
            return Err(ViewError::LevelNotFound);
        }
        self.view_counter += 1;
        let n = self.view_counter;
        let level_name = self
            .document()
            .get_level(level_id)
            .map(|l| l.name.clone())
            .unwrap_or_else(|| "Level".into());
        let cut = self
            .document()
            .get_level(level_id)
            .map(|l| l.elevation)
            .unwrap_or(0.0);
        let view = View::new(
            format!("{level_name} — Plan {n}"),
            ViewKind::Plan {
                level_id,
                cut_height: cut,
                view_range_top: cut + DEFAULT_STOREY_RISE,
                view_range_bottom: cut - 0.5,
            },
        );
        let id = view.id;
        let before = self.export_snapshot();
        self.views.insert(id, view);
        self.push_undo_snapshot(before);
        Ok(id)
    }

    pub fn create_three_d_view(&mut self) -> ViewId {
        self.view_counter += 1;
        let n = self.view_counter;
        let view = View::new(
            format!("3D View {n}"),
            ViewKind::ThreeD {
                camera: StoredCamera::default(),
                projection: StoredProjection::Perspective,
            },
        );
        let id = view.id;
        let before = self.export_snapshot();
        self.views.insert(id, view);
        self.push_undo_snapshot(before);
        id
    }

    pub fn duplicate_view(&mut self, source_id: ViewId) -> Result<ViewId, ViewError> {
        let source = self
            .views
            .get(&source_id)
            .ok_or(ViewError::NotFound)?
            .clone();
        self.view_counter += 1;
        let n = self.view_counter;
        let base_name = source.name.clone();
        let mut copy = source;
        copy.id = ViewId::new();
        copy.name = format!("{base_name} (Copy {n})");
        let id = copy.id;
        let before = self.export_snapshot();
        self.views.insert(id, copy);
        let cloned: Vec<_> = self
            .view_annotations
            .values()
            .filter(|a| a.view_id == source_id)
            .cloned()
            .collect();
        for mut ann in cloned {
            ann.id = ViewAnnotationId::new();
            ann.view_id = id;
            self.view_annotations.insert(ann.id, ann);
        }
        self.push_undo_snapshot(before);
        Ok(id)
    }

    pub fn rename_view(&mut self, id: ViewId, name: String) -> Result<(), ViewError> {
        if !self.views.contains_key(&id) {
            return Err(ViewError::NotFound);
        }
        let before = self.export_snapshot();
        let view = self.views.get_mut(&id).ok_or(ViewError::NotFound)?;
        view.name = name;
        self.push_undo_snapshot(before);
        Ok(())
    }

    pub fn delete_view(&mut self, id: ViewId) -> Result<(), ViewError> {
        if !self.views.contains_key(&id) {
            return Err(ViewError::NotFound);
        }
        let before = self.export_snapshot();
        for sheet in self.sheets.values_mut() {
            sheet.viewports.retain(|vp| vp.view_id != id);
        }
        self.delete_annotations_for_view(id);
        self.views.remove(&id);
        self.push_undo_snapshot(before);
        Ok(())
    }

    pub fn update_view_settings(
        &mut self,
        id: ViewId,
        settings: ViewSettings,
    ) -> Result<(), ViewError> {
        if !self.views.contains_key(&id) {
            return Err(ViewError::NotFound);
        }
        let before = self.export_snapshot();
        let view = self.views.get_mut(&id).ok_or(ViewError::NotFound)?;
        view.settings = settings;
        self.push_undo_snapshot(before);
        Ok(())
    }

    pub fn save_view_camera(&mut self, id: ViewId, kind: ViewKind) -> Result<(), ViewError> {
        if !self.views.contains_key(&id) {
            return Err(ViewError::NotFound);
        }
        let before = self.export_snapshot();
        let view = self.views.get_mut(&id).ok_or(ViewError::NotFound)?;
        view.kind = kind;
        self.push_undo_snapshot(before);
        Ok(())
    }

    pub fn create_sheet(&mut self, number: String, name: String) -> SheetId {
        self.sheet_counter += 1;
        let sheet = Sheet::new(number, name);
        let id = sheet.id;
        let before = self.export_snapshot();
        self.sheets.insert(id, sheet);
        self.push_undo_snapshot(before);
        id
    }

    pub fn rename_sheet(
        &mut self,
        id: SheetId,
        number: String,
        name: String,
    ) -> Result<(), SheetError> {
        if !self.sheets.contains_key(&id) {
            return Err(SheetError::NotFound);
        }
        let before = self.export_snapshot();
        let sheet = self.sheets.get_mut(&id).ok_or(SheetError::NotFound)?;
        sheet.number = number;
        sheet.name = name;
        self.push_undo_snapshot(before);
        Ok(())
    }

    pub fn update_sheet_layout(
        &mut self,
        id: SheetId,
        paper: PaperSize,
        orientation: PaperOrientation,
        custom_width_mm: Option<f32>,
        custom_height_mm: Option<f32>,
    ) -> Result<(), SheetError> {
        if !self.sheets.contains_key(&id) {
            return Err(SheetError::NotFound);
        }
        let before = self.export_snapshot();
        let sheet = self.sheets.get_mut(&id).ok_or(SheetError::NotFound)?;
        sheet.paper = paper;
        sheet.orientation = orientation;
        if paper == PaperSize::Custom {
            if let Some(w) = custom_width_mm {
                sheet.custom_width_mm = w.max(10.0);
            }
            if let Some(h) = custom_height_mm {
                sheet.custom_height_mm = h.max(10.0);
            }
        }
        self.push_undo_snapshot(before);
        Ok(())
    }

    pub fn create_sheet_with_layout(
        &mut self,
        number: String,
        name: String,
        paper: PaperSize,
        orientation: PaperOrientation,
        custom_width_mm: Option<f32>,
        custom_height_mm: Option<f32>,
    ) -> SheetId {
        let mut sheet = Sheet::new(number, name);
        sheet.paper = paper;
        sheet.orientation = orientation;
        if paper == PaperSize::Custom {
            if let Some(w) = custom_width_mm {
                sheet.custom_width_mm = w.max(10.0);
            }
            if let Some(h) = custom_height_mm {
                sheet.custom_height_mm = h.max(10.0);
            }
        }
        let id = sheet.id;
        let before = self.export_snapshot();
        self.sheets.insert(id, sheet);
        self.push_undo_snapshot(before);
        id
    }

    /// Fix legacy viewports saved before world anchors were persisted.
    pub fn repair_sheet_viewport_anchors(&mut self) {
        let mut updates: Vec<(SheetId, SheetViewportId, f32, f32)> = Vec::new();
        for sheet in self.sheets.values() {
            for vp in &sheet.viewports {
                if vp.anchor_x_m == 0.0 && vp.anchor_z_m == 0.0 {
                    if let Some((min, max)) = self.view_plan_bounds_m(vp.view_id) {
                        let (ax, az) = crate::sheet_scale::plan_bounds_center(min, max);
                        updates.push((sheet.id, vp.id, ax, az));
                    }
                }
            }
        }
        for (sheet_id, vp_id, ax, az) in updates {
            if let Some(sheet) = self.sheets.get_mut(&sheet_id) {
                if let Some(vp) = sheet.viewports.iter_mut().find(|v| v.id == vp_id) {
                    vp.anchor_x_m = ax;
                    vp.anchor_z_m = az;
                }
            }
        }
    }

    pub fn delete_sheet(&mut self, id: SheetId) -> Result<(), SheetError> {
        if !self.sheets.contains_key(&id) {
            return Err(SheetError::NotFound);
        }
        let before = self.export_snapshot();
        self.sheets.remove(&id);
        self.push_undo_snapshot(before);
        Ok(())
    }

    fn sheet_holding_view(&self, view_id: ViewId) -> Option<&Sheet> {
        self.sheets
            .values()
            .find(|sheet| sheet.viewports.iter().any(|vp| vp.view_id == view_id))
    }

    /// True-scale viewport frame + world anchor for a plan view.
    fn clamp_viewport_center_on_sheet(
        sheet: &Sheet,
        center_x_mm: f32,
        center_y_mm: f32,
        width_mm: f32,
        height_mm: f32,
    ) -> (f32, f32) {
        let (sw, sh) = sheet.paper_size_mm();
        let half_w = width_mm / 2.0;
        let half_h = height_mm / 2.0;
        let margin = SHEET_VIEWPORT_MARGIN_MM;
        let min_x = (margin + half_w).min(sw);
        let max_x = (sw - margin - half_w).max(min_x);
        let min_y = (margin + half_h).min(sh);
        let max_y = (sh - margin - half_h).max(min_y);
        (
            center_x_mm.clamp(min_x, max_x),
            center_y_mm.clamp(min_y, max_y),
        )
    }

    fn sheet_viewport_layout_for_view(&self, view_id: ViewId) -> (f32, f32, f32, f32, f32) {
        let scale = self
            .views
            .get(&view_id)
            .map(|v| v.settings.scale)
            .unwrap_or(100.0);
        if let Some((min, max)) = self.view_plan_bounds_m(view_id) {
            let (anchor_x, anchor_z) = crate::sheet_scale::plan_bounds_center(min, max);
            let (width_mm, height_mm) =
                crate::sheet_scale::viewport_size_mm_for_bounds(min, max, scale);
            (anchor_x, anchor_z, width_mm, height_mm, scale)
        } else {
            (0.0, 0.0, 120.0, 90.0, scale)
        }
    }

    pub fn place_view_on_sheet(
        &mut self,
        sheet_id: SheetId,
        view_id: ViewId,
        center_x_mm: f32,
        center_y_mm: f32,
        _width_mm: f32,
        _height_mm: f32,
    ) -> Result<SheetViewportId, SheetError> {
        if !self.views.contains_key(&view_id) {
            return Err(SheetError::ViewNotFound);
        }
        if let Some(other) = self.sheet_holding_view(view_id) {
            if other.id != sheet_id {
                return Err(SheetError::ViewAlreadyPlaced(other.number.clone()));
            }
        }
        let existing_id = self
            .sheets
            .get(&sheet_id)
            .ok_or(SheetError::NotFound)?
            .viewports
            .iter()
            .find(|vp| vp.view_id == view_id)
            .map(|vp| vp.id);
        let (anchor_x, anchor_z, auto_w, auto_h, _scale) =
            self.sheet_viewport_layout_for_view(view_id);
        let before = self.export_snapshot();
        let sheet = self.sheets.get_mut(&sheet_id).ok_or(SheetError::NotFound)?;
        let (center_x_mm, center_y_mm) =
            Self::clamp_viewport_center_on_sheet(sheet, center_x_mm, center_y_mm, auto_w, auto_h);
        if let Some(vp_id) = existing_id {
            let existing = sheet
                .viewports
                .iter_mut()
                .find(|vp| vp.id == vp_id)
                .expect("viewport id from same sheet");
            existing.center_x_mm = center_x_mm;
            existing.center_y_mm = center_y_mm;
            existing.width_mm = auto_w;
            existing.height_mm = auto_h;
            existing.anchor_x_m = anchor_x;
            existing.anchor_z_m = anchor_z;
            existing.lock_navigation = true;
            self.push_undo_snapshot(before);
            return Ok(vp_id);
        }
        let mut vp = SheetViewport::new(view_id, center_x_mm, center_y_mm, auto_w, auto_h);
        vp.anchor_x_m = anchor_x;
        vp.anchor_z_m = anchor_z;
        let vp_id = vp.id;
        sheet.viewports.push(vp);
        self.push_undo_snapshot(before);
        Ok(vp_id)
    }

    /// Set viewport scale (Revit-style: view scale follows viewport) and resize frame about its centre.
    pub fn set_sheet_viewport_scale(
        &mut self,
        sheet_id: SheetId,
        viewport_id: SheetViewportId,
        scale_denominator: f32,
    ) -> Result<(), SheetError> {
        let scale = scale_denominator.max(1.0);
        if !self
            .sheets
            .get(&sheet_id)
            .ok_or(SheetError::NotFound)?
            .viewports
            .iter()
            .any(|vp| vp.id == viewport_id)
        {
            return Err(SheetError::ViewportNotFound);
        }
        let view_id = self
            .sheets
            .get(&sheet_id)
            .ok_or(SheetError::NotFound)?
            .viewports
            .iter()
            .find(|vp| vp.id == viewport_id)
            .map(|vp| vp.view_id)
            .expect("viewport exists");
        let (anchor_x, anchor_z, width_mm, height_mm) = match self.view_plan_bounds_m(view_id) {
            Some((min, max)) => {
                let (ax, az) = crate::sheet_scale::plan_bounds_center(min, max);
                let (w, h) = crate::sheet_scale::viewport_size_mm_for_bounds(min, max, scale);
                (ax, az, w, h)
            }
            None => (0.0, 0.0, 120.0, 90.0),
        };
        let before = self.export_snapshot();
        if let Some(view) = self.views.get_mut(&view_id) {
            view.settings.scale = scale;
        }
        let sheet = self.sheets.get_mut(&sheet_id).ok_or(SheetError::NotFound)?;
        let vp = sheet
            .viewports
            .iter_mut()
            .find(|vp| vp.id == viewport_id)
            .expect("viewport exists");
        vp.width_mm = width_mm;
        vp.height_mm = height_mm;
        vp.anchor_x_m = anchor_x;
        vp.anchor_z_m = anchor_z;
        vp.lock_navigation = true;
        self.push_undo_snapshot(before);
        Ok(())
    }

    pub fn move_sheet_viewport(
        &mut self,
        sheet_id: SheetId,
        viewport_id: SheetViewportId,
        center_x_mm: f32,
        center_y_mm: f32,
    ) -> Result<(), SheetError> {
        if !self
            .sheets
            .get(&sheet_id)
            .ok_or(SheetError::NotFound)?
            .viewports
            .iter()
            .any(|vp| vp.id == viewport_id)
        {
            return Err(SheetError::ViewportNotFound);
        }
        let before = self.export_snapshot();
        let sheet = self.sheets.get_mut(&sheet_id).ok_or(SheetError::NotFound)?;
        let (width_mm, height_mm) = {
            let vp = sheet
                .viewports
                .iter()
                .find(|vp| vp.id == viewport_id)
                .expect("viewport exists");
            (vp.width_mm, vp.height_mm)
        };
        let (center_x_mm, center_y_mm) = Self::clamp_viewport_center_on_sheet(
            sheet,
            center_x_mm,
            center_y_mm,
            width_mm,
            height_mm,
        );
        let vp = sheet
            .viewports
            .iter_mut()
            .find(|vp| vp.id == viewport_id)
            .expect("viewport exists");
        vp.center_x_mm = center_x_mm;
        vp.center_y_mm = center_y_mm;
        self.push_undo_snapshot(before);
        Ok(())
    }

    pub fn set_sheet_viewport_crop(
        &mut self,
        sheet_id: SheetId,
        viewport_id: SheetViewportId,
        crop_polygon: Vec<[f32; 2]>,
    ) -> Result<(), SheetError> {
        let crop_polygon = crate::viewport_crop::normalize_crop_polygon(&crop_polygon)
            .map_err(|_| SheetError::InvalidCrop)?;
        if !self
            .sheets
            .get(&sheet_id)
            .ok_or(SheetError::NotFound)?
            .viewports
            .iter()
            .any(|vp| vp.id == viewport_id)
        {
            return Err(SheetError::ViewportNotFound);
        }
        let before = self.export_snapshot();
        let sheet = self.sheets.get_mut(&sheet_id).ok_or(SheetError::NotFound)?;
        let vp = sheet
            .viewports
            .iter_mut()
            .find(|vp| vp.id == viewport_id)
            .expect("viewport exists");
        vp.crop_polygon = crop_polygon;
        self.push_undo_snapshot(before);
        Ok(())
    }

    pub fn reset_sheet_viewport_crop(
        &mut self,
        sheet_id: SheetId,
        viewport_id: SheetViewportId,
    ) -> Result<(), SheetError> {
        self.set_sheet_viewport_crop(
            sheet_id,
            viewport_id,
            crate::viewport_crop::default_crop_polygon_uv(),
        )
    }

    pub fn update_sheet_viewport_state(
        &mut self,
        sheet_id: SheetId,
        viewport_id: SheetViewportId,
        camera: Option<StoredCamera>,
        lock_navigation: bool,
    ) -> Result<(), SheetError> {
        if !self
            .sheets
            .get(&sheet_id)
            .ok_or(SheetError::NotFound)?
            .viewports
            .iter()
            .any(|vp| vp.id == viewport_id)
        {
            return Err(SheetError::ViewportNotFound);
        }
        let before = self.export_snapshot();
        let sheet = self.sheets.get_mut(&sheet_id).ok_or(SheetError::NotFound)?;
        let vp = sheet
            .viewports
            .iter_mut()
            .find(|vp| vp.id == viewport_id)
            .expect("viewport exists");
        vp.camera = camera;
        vp.lock_navigation = lock_navigation;
        self.push_undo_snapshot(before);
        Ok(())
    }

    pub fn remove_sheet_viewport(
        &mut self,
        sheet_id: SheetId,
        viewport_id: SheetViewportId,
    ) -> Result<(), SheetError> {
        if !self
            .sheets
            .get(&sheet_id)
            .ok_or(SheetError::NotFound)?
            .viewports
            .iter()
            .any(|vp| vp.id == viewport_id)
        {
            return Err(SheetError::ViewportNotFound);
        }
        let before = self.export_snapshot();
        let sheet = self.sheets.get_mut(&sheet_id).ok_or(SheetError::NotFound)?;
        sheet.viewports.retain(|vp| vp.id != viewport_id);
        self.push_undo_snapshot(before);
        Ok(())
    }
}
