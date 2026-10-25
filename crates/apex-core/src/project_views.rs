//! Saved views and sheets on [`crate::project::Project`].

use crate::level::LevelId;
use crate::project::Project;
use crate::sheet::{
    PaperOrientation, PaperSize, Sheet, SheetError, SheetId, SheetViewport, SheetViewportId,
};
use crate::view::{
    StoredCamera, StoredProjection, View, ViewError, ViewId, ViewKind, ViewSettings,
};

const DEFAULT_STOREY_RISE: f32 = 3.0;

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
        self.views.insert(id, view);
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
        self.views.insert(id, view);
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
        self.views.insert(id, copy);
        Ok(id)
    }

    pub fn rename_view(&mut self, id: ViewId, name: String) -> Result<(), ViewError> {
        let view = self.views.get_mut(&id).ok_or(ViewError::NotFound)?;
        view.name = name;
        Ok(())
    }

    pub fn delete_view(&mut self, id: ViewId) -> Result<(), ViewError> {
        if !self.views.contains_key(&id) {
            return Err(ViewError::NotFound);
        }
        for sheet in self.sheets.values_mut() {
            sheet.viewports.retain(|vp| vp.view_id != id);
        }
        self.views.remove(&id);
        Ok(())
    }

    pub fn update_view_settings(
        &mut self,
        id: ViewId,
        settings: ViewSettings,
    ) -> Result<(), ViewError> {
        let view = self.views.get_mut(&id).ok_or(ViewError::NotFound)?;
        view.settings = settings;
        Ok(())
    }

    pub fn save_view_camera(&mut self, id: ViewId, kind: ViewKind) -> Result<(), ViewError> {
        let view = self.views.get_mut(&id).ok_or(ViewError::NotFound)?;
        view.kind = kind;
        Ok(())
    }

    pub fn create_sheet(&mut self, number: String, name: String) -> SheetId {
        self.sheet_counter += 1;
        let sheet = Sheet::new(number, name);
        let id = sheet.id;
        self.sheets.insert(id, sheet);
        id
    }

    pub fn rename_sheet(
        &mut self,
        id: SheetId,
        number: String,
        name: String,
    ) -> Result<(), SheetError> {
        let sheet = self.sheets.get_mut(&id).ok_or(SheetError::NotFound)?;
        sheet.number = number;
        sheet.name = name;
        Ok(())
    }

    pub fn update_sheet_layout(
        &mut self,
        id: SheetId,
        paper: PaperSize,
        orientation: PaperOrientation,
    ) -> Result<(), SheetError> {
        let sheet = self.sheets.get_mut(&id).ok_or(SheetError::NotFound)?;
        sheet.paper = paper;
        sheet.orientation = orientation;
        Ok(())
    }

    pub fn delete_sheet(&mut self, id: SheetId) -> Result<(), SheetError> {
        if self.sheets.remove(&id).is_none() {
            return Err(SheetError::NotFound);
        }
        Ok(())
    }

    fn sheet_holding_view(&self, view_id: ViewId) -> Option<&Sheet> {
        self.sheets
            .values()
            .find(|sheet| sheet.viewports.iter().any(|vp| vp.view_id == view_id))
    }

    pub fn place_view_on_sheet(
        &mut self,
        sheet_id: SheetId,
        view_id: ViewId,
        center_x_mm: f32,
        center_y_mm: f32,
        width_mm: f32,
        height_mm: f32,
    ) -> Result<SheetViewportId, SheetError> {
        if !self.views.contains_key(&view_id) {
            return Err(SheetError::ViewNotFound);
        }
        if let Some(other) = self.sheet_holding_view(view_id) {
            if other.id != sheet_id {
                return Err(SheetError::ViewAlreadyPlaced(other.number.clone()));
            }
        }
        let sheet = self.sheets.get_mut(&sheet_id).ok_or(SheetError::NotFound)?;
        if let Some(existing) = sheet.viewports.iter_mut().find(|vp| vp.view_id == view_id) {
            existing.center_x_mm = center_x_mm;
            existing.center_y_mm = center_y_mm;
            existing.width_mm = width_mm;
            existing.height_mm = height_mm;
            return Ok(existing.id);
        }
        let vp = SheetViewport::new(view_id, center_x_mm, center_y_mm, width_mm, height_mm);
        let vp_id = vp.id;
        sheet.viewports.push(vp);
        Ok(vp_id)
    }

    pub fn move_sheet_viewport(
        &mut self,
        sheet_id: SheetId,
        viewport_id: SheetViewportId,
        center_x_mm: f32,
        center_y_mm: f32,
    ) -> Result<(), SheetError> {
        let sheet = self.sheets.get_mut(&sheet_id).ok_or(SheetError::NotFound)?;
        let vp = sheet
            .viewports
            .iter_mut()
            .find(|vp| vp.id == viewport_id)
            .ok_or(SheetError::ViewportNotFound)?;
        vp.center_x_mm = center_x_mm;
        vp.center_y_mm = center_y_mm;
        Ok(())
    }

    pub fn remove_sheet_viewport(
        &mut self,
        sheet_id: SheetId,
        viewport_id: SheetViewportId,
    ) -> Result<(), SheetError> {
        let sheet = self.sheets.get_mut(&sheet_id).ok_or(SheetError::NotFound)?;
        let before = sheet.viewports.len();
        sheet.viewports.retain(|vp| vp.id != viewport_id);
        if sheet.viewports.len() == before {
            return Err(SheetError::ViewportNotFound);
        }
        Ok(())
    }
}
