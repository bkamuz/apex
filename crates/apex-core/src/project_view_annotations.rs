//! View annotations + anchor resolution on [`Project`].

use glam::Vec3;

use crate::project::Project;
use crate::view::ViewId;
use crate::view_annotation::{
    linear_dimension_overlay, AnnotationAnchor, GridAxisEnd, ViewAnnotation, ViewAnnotationError,
    ViewAnnotationId, ViewAnnotationKind, ViewAnnotationOverlay,
};

impl Project {
    pub fn view_annotations(&self) -> impl Iterator<Item = &ViewAnnotation> {
        self.view_annotations.values()
    }

    pub fn view_annotations_for(&self, view_id: ViewId) -> impl Iterator<Item = &ViewAnnotation> {
        self.view_annotations
            .values()
            .filter(move |a| a.view_id == view_id)
    }

    pub fn get_view_annotation(&self, id: ViewAnnotationId) -> Option<&ViewAnnotation> {
        self.view_annotations.get(&id)
    }

    pub fn create_view_annotation(
        &mut self,
        view_id: ViewId,
        kind: ViewAnnotationKind,
    ) -> Result<ViewAnnotationId, ViewAnnotationError> {
        if !self.views.contains_key(&view_id) {
            return Err(ViewAnnotationError::ViewNotFound);
        }
        let before = self.export_snapshot();
        let annotation = ViewAnnotation::new(view_id, kind);
        let id = annotation.id;
        self.view_annotations.insert(id, annotation);
        self.view_annotation_counter += 1;
        self.push_undo_snapshot(before);
        Ok(id)
    }

    pub fn update_view_annotation(
        &mut self,
        id: ViewAnnotationId,
        kind: ViewAnnotationKind,
    ) -> Result<(), ViewAnnotationError> {
        let before = self.export_snapshot();
        let annotation = self
            .view_annotations
            .get_mut(&id)
            .ok_or(ViewAnnotationError::NotFound)?;
        annotation.kind = kind;
        self.push_undo_snapshot(before);
        Ok(())
    }

    pub fn delete_view_annotation(
        &mut self,
        id: ViewAnnotationId,
    ) -> Result<(), ViewAnnotationError> {
        let before = self.export_snapshot();
        if self.view_annotations.remove(&id).is_none() {
            return Err(ViewAnnotationError::NotFound);
        }
        self.push_undo_snapshot(before);
        Ok(())
    }

    pub fn resolve_annotation_anchor(&self, anchor: &AnnotationAnchor) -> Option<Vec3> {
        match anchor {
            AnnotationAnchor::World { point } => Some(Vec3::from_array(*point)),
            AnnotationAnchor::ElementAnchor {
                element_id,
                anchor_index,
            } => {
                let element = self.document().get_element(*element_id)?;
                let anchors = element.placement.anchors();
                anchors.get(*anchor_index as usize).copied()
            }
            AnnotationAnchor::GridAxisEnd { grid_axis_id, end } => {
                let axis = self
                    .document()
                    .grid_axes()
                    .find(|g| g.id == *grid_axis_id)?;
                let anchors = axis.placement.anchors();
                if anchors.is_empty() {
                    return None;
                }
                match end {
                    GridAxisEnd::Start => Some(anchors[0]),
                    GridAxisEnd::End => Some(*anchors.last()?),
                }
            }
        }
    }

    pub fn annotation_overlay(&self, annotation: &ViewAnnotation) -> ViewAnnotationOverlay {
        match &annotation.kind {
            ViewAnnotationKind::LinearDimension { a, b, offset } => {
                let Some(a) = self.resolve_annotation_anchor(a) else {
                    return ViewAnnotationOverlay::default();
                };
                let Some(b) = self.resolve_annotation_anchor(b) else {
                    return ViewAnnotationOverlay::default();
                };
                linear_dimension_overlay(a, b, *offset)
            }
            ViewAnnotationKind::TextNote { position, text } => {
                let Some(p) = self.resolve_annotation_anchor(position) else {
                    return ViewAnnotationOverlay::default();
                };
                ViewAnnotationOverlay {
                    line_segments: vec![],
                    labels: vec![crate::annotation::AnnotationLabel {
                        position: p,
                        text: text.clone(),
                    }],
                }
            }
            ViewAnnotationKind::LeaderTag { head, tail, text } => {
                let Some(h) = self.resolve_annotation_anchor(head) else {
                    return ViewAnnotationOverlay::default();
                };
                let Some(t) = self.resolve_annotation_anchor(tail) else {
                    return ViewAnnotationOverlay::default();
                };
                ViewAnnotationOverlay {
                    line_segments: vec![t, h],
                    labels: vec![crate::annotation::AnnotationLabel {
                        position: h + Vec3::Y * 0.05,
                        text: text.clone(),
                    }],
                }
            }
        }
    }

    pub fn delete_annotations_for_view(&mut self, view_id: ViewId) {
        self.view_annotations.retain(|_, a| a.view_id != view_id);
    }
}
